"""24-hour prepared-report cache backed by frappe.cache (Redis).

Every dashboard endpoint wraps its computation in ``get_or_compute``.

- Every key carries a Redis expiry, so arbitrary date ranges don't pile up forever.
- A section is cleared by key pattern, so no key can escape a refresh or settings save.
- A Redis lock stops several users from recomputing the same report at once: the
  first computes, the rest wait briefly and read its result.
- Ledger postings (after they commit) and completed reposts bump a data version. A
  cached payload from an older version is served with ``stale: true``; once it is older
  than ``_STALE_GRACE`` a background job recomputes it, so no web request blocks on it.
"""

from __future__ import annotations

import copy

import frappe
from frappe.utils import get_datetime, now_datetime

_TTL = 24 * 60 * 60
_STALE_GRACE = 15 * 60
_LOCK_TIMEOUT = 5 * 60  # a killed computation frees the lock after this
_LOCK_WAIT = 60  # well under the web worker timeout
_PFX = "prepared_report"
_VERSION_KEY = f"{_PFX}|data_version"

# Submitting or cancelling one of these changes GL or stock ledger figures.
LEDGER_DOCTYPES = frozenset(
	{
		"Sales Invoice",
		"Purchase Invoice",
		"Delivery Note",
		"Purchase Receipt",
		"Journal Entry",
		"Payment Entry",
		"Stock Entry",
		"Stock Reconciliation",
		"Landed Cost Voucher",
		"Period Closing Voucher",
		"Asset",
		"Asset Capitalization",
		"Asset Repair",
		"Invoice Discounting",
		"Exchange Rate Revaluation",
		"Process Deferred Accounting",
		"Subcontracting Receipt",
		"Payroll Entry",
		"Expense Claim",
		"Repost Accounting Ledger",
		"Unreconcile Payment",
		"Payment Reconciliation",
	}
)


def _key(section: str, endpoint: str, params: dict | None = None) -> str:
	parts = [_PFX, section, endpoint]
	if params:
		parts.extend(f"{k}={v}" for k, v in sorted(params.items()) if v is not None)
	return "|".join(parts)


def _data_version() -> str:
	"""Counter bumped on ledger postings, plus the last completed repost. Reposts rewrite
	stock and GL values through direct SQL, so no document hook fires for them."""
	cache = frappe.cache()
	counter = cache.get(cache.make_key(_VERSION_KEY))
	counter = counter.decode() if isinstance(counter, bytes) else str(counter or 0)
	last_repost = ""
	if frappe.db.table_exists("Repost Item Valuation"):
		row = frappe.db.sql(
			"select max(modified) from `tabRepost Item Valuation` where status = 'Completed' and docstatus = 1"
		)
		last_repost = str(row[0][0] or "") if row else ""
	return f"{counter}:{last_repost}"


def bump_data_version(doc=None, method=None) -> None:
	"""doc_events hook: mark every cached report as built on old data. Runs after the
	transaction commits, so a report computed meanwhile can't cache pre-posting data
	under the new version."""
	if doc is not None and doc.doctype not in LEDGER_DOCTYPES:
		return
	if doc is not None and getattr(frappe.db, "after_commit", None) is not None:
		frappe.db.after_commit.add(_bump)
	else:
		_bump()


def _bump() -> None:
	cache = frappe.cache()
	try:
		cache.incr(cache.make_key(_VERSION_KEY))
	except Exception:
		# Never block a submit because Redis is unavailable.
		pass


def _usable(entry, version: str) -> tuple[bool, bool]:
	"""(usable, stale) for a cached entry."""
	if not entry or not entry.get("_ts"):
		return False, False
	age = (now_datetime() - get_datetime(entry["_ts"])).total_seconds()
	if age >= _TTL:
		return False, False
	if entry.get("_ver") == version:
		return True, False
	return (age < _STALE_GRACE), True


def _payload(entry: dict, stale: bool) -> dict:
	# Copy: frappe.cache keeps the same object in its request-local cache.
	data = copy.deepcopy(entry["_data"])
	data["stale"] = stale
	return data


def get_or_compute(
	section: str,
	endpoint: str,
	compute_fn,
	params: dict | None = None,
	job: tuple[str, dict] | None = None,
) -> dict:
	"""Cached payload for (section, endpoint, params).

	``job`` = (dotted path of the compute function, its kwargs). With it, a stale payload
	past the grace period is refreshed by a background job instead of the web request.
	"""
	cache = frappe.cache()
	key = _key(section, endpoint, params)
	version = _data_version()

	entry = cache.get_value(key, expires=True)
	usable, stale = _usable(entry, version)
	if usable:
		return _payload(entry, stale)
	if stale and job and _within_ttl(entry):
		# Stale beyond the grace period: serve it, refresh in the background.
		_enqueue_refresh(section, endpoint, params, job)
		return _payload(entry, True)

	lock = cache.lock(cache.make_key(f"{key}|lock"), timeout=_LOCK_TIMEOUT, blocking_timeout=_LOCK_WAIT)
	acquired = False
	try:
		acquired = lock.acquire()
	except Exception:
		acquired = False
	try:
		# Someone else may have finished computing while we waited for the lock.
		entry = cache.get_value(key, expires=True)
		usable, stale = _usable(entry, version)
		if usable:
			return _payload(entry, stale)
		return _store(key, version, compute_fn())
	finally:
		if acquired:
			try:
				lock.release()
			except Exception:
				pass


def _within_ttl(entry: dict) -> bool:
	return (now_datetime() - get_datetime(entry["_ts"])).total_seconds() < _TTL


def _store(key: str, version: str, data: dict) -> dict:
	ts = now_datetime().isoformat()
	data["refreshed_at"] = ts
	frappe.cache().set_value(key, {"_ts": ts, "_ver": version, "_data": data}, expires_in_sec=_TTL)
	out = copy.deepcopy(data)
	out["stale"] = False
	return out


def _enqueue_refresh(section: str, endpoint: str, params: dict | None, job: tuple[str, dict]) -> None:
	key = _key(section, endpoint, params)
	try:
		frappe.enqueue(
			"company_dashboard.api.report_cache.refresh_entry",
			queue="long",
			job_id=f"cd-refresh|{key}",
			deduplicate=True,
			enqueue_after_commit=True,
			key=key,
			compute=job[0],
			compute_kwargs=job[1],
		)
	except Exception:
		# Queue unavailable: the stale copy is still served; the next fresh compute fixes it.
		pass


def refresh_entry(key: str, compute: str, compute_kwargs: dict) -> None:
	"""Background job: recompute one cached report under its lock."""
	cache = frappe.cache()
	lock = cache.lock(cache.make_key(f"{key}|lock"), timeout=_LOCK_TIMEOUT, blocking_timeout=1)
	try:
		if not lock.acquire():
			return  # someone is already computing it
	except Exception:
		return
	try:
		version = _data_version()
		usable, stale = _usable(cache.get_value(key, expires=True), version)
		if usable and not stale:
			return
		_store(key, version, frappe.get_attr(compute)(**compute_kwargs))
	finally:
		try:
			lock.release()
		except Exception:
			pass


def clear_section(section: str) -> int:
	"""Delete every cached report of a section (all endpoints, companies and periods)."""
	cache = frappe.cache()
	keys = list(cache.scan_iter(match=cache.make_key(f"{_PFX}|{section}|*"), count=500))
	if keys:
		cache.delete(*keys)
	for k in keys:
		frappe.local.cache.pop(k, None)
	return len(keys)


@frappe.whitelist()
def refresh_dashboard(section: str) -> dict:
	if section not in ("mis", "wc"):
		frappe.throw("Invalid section — must be 'mis' or 'wc'")
	# Gate by the same role that guards the section's read endpoints — otherwise any
	# authenticated user could repeatedly wipe the cache and force the heavy BNS AR/AP +
	# FIFO aging reports to recompute (a cheap DoS on an expensive path).
	from company_dashboard.api.mis import _require_mis_access, _require_wc_access

	if section == "mis":
		_require_mis_access()
	else:
		_require_wc_access()
	cleared = clear_section(section)
	return {"status": "ok", "section": section, "cleared": cleared}
