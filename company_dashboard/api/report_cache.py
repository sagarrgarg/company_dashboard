"""24-hour prepared-report cache backed by frappe.cache (Redis).

Every dashboard endpoint wraps its computation in ``get_or_compute``.
The result is served from cache until 24 hours elapse or a manual
``refresh_dashboard`` call clears the section.
"""
from __future__ import annotations

import frappe
from frappe.utils import get_datetime, now_datetime

_TTL = 24 * 60 * 60
_PFX = "prepared_report"


def _key(section: str, endpoint: str, params: dict | None = None) -> str:
	parts = [_PFX, section, endpoint]
	if params:
		parts.extend(f"{k}={v}" for k, v in sorted(params.items()) if v is not None)
	return "|".join(parts)


def get_or_compute(
	section: str,
	endpoint: str,
	compute_fn,
	params: dict | None = None,
) -> dict:
	key = _key(section, endpoint, params)
	cached = frappe.cache().get_value(key)
	if cached:
		refreshed_at = cached.get("_ts")
		if refreshed_at:
			age = (now_datetime() - get_datetime(refreshed_at)).total_seconds()
			if age < _TTL:
				return cached["_data"]

	data = compute_fn()
	ts = now_datetime().isoformat()
	data["refreshed_at"] = ts
	frappe.cache().set_value(key, {"_ts": ts, "_data": data})
	_track(section, key)
	return data


def _track(section: str, key: str) -> None:
	tracker = f"{_PFX}|_keys|{section}"
	known = frappe.cache().get_value(tracker) or []
	if key not in known:
		known.append(key)
		frappe.cache().set_value(tracker, known)


def clear_section(section: str) -> int:
	tracker = f"{_PFX}|_keys|{section}"
	known = frappe.cache().get_value(tracker) or []
	for k in known:
		frappe.cache().delete_value(k)
	frappe.cache().delete_value(tracker)
	return len(known)


@frappe.whitelist()
def refresh_dashboard(section: str) -> dict:
	if section not in ("mis", "wc"):
		frappe.throw("Invalid section — must be 'mis' or 'wc'")
	cleared = clear_section(section)
	return {"status": "ok", "section": section, "cleared": cleared}
