"""Sales invoice feed — the newest invoice on top and every other invoice in a filterable
list, each with its lines' sale rate and COGS rate.

Rules (keep the UI labels in sync):

- **Invoices** are submitted Sales Invoices of the company, opening invoices and internal
  customers excluded (same rule as the rest of the dashboard). Returns (credit notes) are
  included and carry negative amounts.
- **The whole invoice is shown**: every line, whatever income account it is booked to.
  This page is a document feed, not a revenue figure, so totals here can differ from the
  MIS revenue (which counts only the configured Sales accounts).
- **Sale rate** is ``base_net_rate`` (ex-tax, company currency). Incl.-tax mode scales it by
  the invoice's grand total / net total, the same pro-rating the MIS pages use.
- **COGS of a sale is the incoming rate**: the Sales Invoice line's ``incoming_rate``, else
  the linked Delivery Note line's ``incoming_rate``, else unknown (``None``, shown as "—").
  ERPNext keeps ``incoming_rate`` per stock UOM, so the line's COGS amount is
  ``incoming_rate * stock_qty`` and the rate shown next to the sale rate is
  ``incoming_rate * conversion_factor`` (per the invoice's UOM).
- **COGS of a return is the booked stock value**: what the stock ledger actually took back
  (the credit note's own entries, or its return Delivery Note's, pro-rated by quantity —
  ``mis.LINE_COST``, the same figure the MIS pages use). ERPNext copies the original
  invoice's incoming rate onto a credit note, which is not what the goods came back at.
  A credit note that moved no stock has no COGS ("—").
- **Implausible lines are flagged, not counted** (the MIS rule): a line whose COGS is at
  least ₹500 and more than 5x its revenue is almost always a stock-valuation error. It is
  shown with a flag, and left out of every COGS, gross-profit and margin total.
- **Margins are ex-tax** and computed only over valued, unflagged lines; the response says
  how many lines were left out and why. KPI margins are ``None`` below ₹1,000 of revenue
  (dashboard-wide rule); invoice and line margins have no floor.
- **"Latest"** is the newest by posting date, posting time, then creation, and ignores the
  list filters.
- **Freshness:** the list / KPI payload is cached for up to 10 minutes under the
  dashboard's submit/cancel counter (see ``report_cache``), so a new or cancelled invoice
  always misses the cache. A stock repost (which can change a return's booked value) is
  picked up when the entry expires. The newest invoice and the dialog are never cached.
- **Rate limit:** per user, per endpoint, per minute (Administrator exempt).
"""

from __future__ import annotations

import copy
import hashlib
import json
import time
from datetime import date, timedelta
from urllib.parse import urlencode

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, getdate, now_datetime, today

from company_dashboard.api.finance import desk_url
from company_dashboard.api.mis import (
	ANOMALY_COST_TO_REVENUE,
	ANOMALY_MIN_COST,
	LINE_COST,
	TAX_MODES,
	_internal_customer_sql,
	_pct,
	_require_dashboard_access,
	_resolve_company,
)
from company_dashboard.api.report_cache import _VERSION_KEY, _bump

# Realtime event the SPA listens to. Carries no data: clients refetch through the
# permission-checked API.
REALTIME_EVENT = "company_dashboard_sales_invoice"

RANGES = ("today", "7d", "30d", "month", "fy", "custom")
DEFAULT_RANGE = "30d"
MAX_PAGE = 100
MAX_RANGE_DAYS = 3 * 366
CUSTOMER_OPTIONS_LIMIT = 500
# The key carries the submit/cancel counter; the TTL bounds memory and repost staleness.
CACHE_TTL = 10 * 60
# Requests per user per minute. The page makes one feed call per filter change (search is
# debounced) and one detail call per dialog step, so a person never gets near these.
FEED_LIMIT_PER_MIN = 60
DETAIL_LIMIT_PER_MIN = 120

# Invoice-level joins: customer for the internal-customer rule and names.
SI_FROM = """
	`tabSales Invoice` si
	left join `tabCustomer` c on c.name = si.customer
"""

# Line-level joins (aliases si / sii / dni are what mis.LINE_COST expects). Only a submitted
# Delivery Note line counts — a draft or cancelled one never supplies a COGS rate.
LINE_FROM = """
	`tabSales Invoice Item` sii
	join `tabSales Invoice` si on si.name = sii.parent
	left join `tabCustomer` c on c.name = si.customer
	left join `tabDelivery Note Item` dni on dni.name = sii.dn_detail and dni.docstatus = 1
"""

# Incoming rate per stock UOM (NULL = unknown).
INCOMING_RATE = "coalesce(nullif(sii.incoming_rate, 0), nullif(dni.incoming_rate, 0))"
STOCK_QTY = "coalesce(nullif(sii.stock_qty, 0), sii.qty * coalesce(nullif(sii.conversion_factor, 0), 1))"
# Line COGS amount (NULL = unknown): booked stock value for a return, incoming rate for a
# sale. A credit note's quantities are negative, so its COGS is negative like its revenue.
LINE_COGS = f"(case when si.is_return = 1 then ({LINE_COST}) else ({INCOMING_RATE}) * {STOCK_QTY} end)"
# Ex-tax → incl.-tax factor of the invoice.
INCL_FACTOR = "(case when si.base_net_total != 0 then si.base_grand_total / si.base_net_total else 1 end)"

CUSTOMER_GROUP = "coalesce(nullif(si.customer_group, ''), c.customer_group)"
CUSTOMER_NAME = "coalesce(nullif(c.customer_name, ''), nullif(si.customer_name, ''), si.customer)"
# Newest first; creation breaks ties within the same minute.
NEWEST_FIRST = "si.posting_date desc, si.posting_time desc, si.creation desc"


def _flag_sql(cogs: str, sale: str) -> str:
	"""SQL: the line's COGS is implausible (see module doc)."""
	return (
		f"(abs({cogs}) >= {float(ANOMALY_MIN_COST)} "
		f"and abs({cogs}) > {float(ANOMALY_COST_TO_REVENUE)} * abs({sale}))"
	)


def _is_flagged(cogs: float | None, sale: float) -> bool:
	return (
		cogs is not None and abs(cogs) >= ANOMALY_MIN_COST and abs(cogs) > ANOMALY_COST_TO_REVENUE * abs(sale)
	)


# Per-line COGS computed once (its return branch runs correlated subqueries), then
# aggregated by the outer query. Lines: x.parent, x.sale (ex-tax), x.qty, x.cogs.
def _lines_subquery(where: str) -> str:
	return f"""(
		select sii.parent, sii.base_net_amount as sale, sii.qty, {LINE_COGS} as cogs
		from {LINE_FROM} where {where}
	) x"""


# Aggregates over _lines_subquery: valued (has COGS, not flagged), missing, flagged.
_X_OK = f"(x.cogs is not null and not {_flag_sql('x.cogs', 'x.sale')})"
LINE_AGGREGATES = f"""
	coalesce(sum(case when {_X_OK} then x.cogs else 0 end), 0) as cogs,
	coalesce(sum(case when {_X_OK} then x.sale else 0 end), 0) as valued_sale,
	sum(case when {_X_OK} then 1 else 0 end) as valued,
	sum(case when x.cogs is null then 1 else 0 end) as missing,
	sum(case when x.cogs is not null and {_flag_sql("x.cogs", "x.sale")} then 1 else 0 end) as flagged,
	count(*) as line_count
"""


# ── rate limit ──────────────────────────────────────────────────────────────


def _rate_limit(endpoint: str, limit: int) -> None:
	"""Fixed one-minute window per user and endpoint (Frappe's own rate_limit keys on IP,
	and a whole office can share one IP)."""
	user = frappe.session.user
	if user == "Administrator":
		return
	cache = frappe.cache()
	key = cache.make_key(f"company_dashboard|rl|{endpoint}|{user}|{int(time.time() // 60)}")
	try:
		count = cache.incr(key)
		if count == 1:
			cache.expire(key, 120)
	except Exception:
		return  # Redis unavailable: don't take the page down over a limiter
	if count > limit:
		frappe.throw(
			_("Too many requests. Please wait a minute and try again."),
			frappe.RateLimitExceededError,
		)


# ── realtime ────────────────────────────────────────────────────────────────


def notify_invoice_change(doc, method=None):
	"""doc_events hook (Sales Invoice on_submit / on_cancel): tell open dashboards to refetch.

	One message per transaction, sent only after it commits (a bulk submit of 50 invoices
	in one request sends one message; nothing is sent if the transaction rolls back).
	Never raises — a dashboard ping must not block an invoice."""
	try:
		if frappe.flags.get("cd_invoice_notify_pending"):
			return
		frappe.flags.cd_invoice_notify_pending = True
		frappe.db.after_commit.add(_publish_invoice_change)
		frappe.db.after_rollback.add(_clear_invoice_notify)
	except Exception:
		frappe.flags.cd_invoice_notify_pending = False
		frappe.log_error(title="Company Dashboard: invoice realtime ping failed")


def _publish_invoice_change():
	frappe.flags.cd_invoice_notify_pending = False
	# Bump the data version before the ping, so the refetch it triggers can never read a
	# cached list from before this invoice (bump_data_version's own callback may run later).
	_bump()
	try:
		# No room → the site room: every logged-in System User (dashboard users are created
		# as System Users). The payload is empty on purpose.
		frappe.publish_realtime(REALTIME_EVENT, {})
	except Exception:
		frappe.log_error(title="Company Dashboard: invoice realtime ping failed")


def _clear_invoice_notify():
	frappe.flags.cd_invoice_notify_pending = False


# ── ranges ──────────────────────────────────────────────────────────────────


def _fiscal_year_bounds(company: str, on: date) -> tuple[date, date]:
	try:
		from erpnext.accounts.utils import get_fiscal_year

		fy = get_fiscal_year(on, company=company)
		return getdate(fy[1]), getdate(fy[2])
	except Exception:
		# No fiscal year set up: Indian FY (Apr to Mar) containing the date.
		start_year = on.year if on.month >= 4 else on.year - 1
		return date(start_year, 4, 1), date(start_year + 1, 3, 31)


def _resolve_range(
	company: str, range_key: str | None, from_date: str | None, to_date: str | None
) -> tuple[str, date, date]:
	"""(key, from, to) for the list filter, computed on the server's calendar."""
	key = range_key if range_key in RANGES else DEFAULT_RANGE
	t = getdate(today())
	if key == "today":
		return key, t, t
	if key == "7d":
		return key, getdate(add_days(t, -6)), t
	if key == "30d":
		return key, getdate(add_days(t, -29)), t
	if key == "month":
		return key, t.replace(day=1), t
	if key == "fy":
		f, end = _fiscal_year_bounds(company, t)
		return key, f, min(end, t)
	# custom
	if not from_date or not to_date:
		frappe.throw(_("Pick both a from and a to date."))
	f, end = getdate(from_date), getdate(to_date)
	if f > end:
		frappe.throw(_("From date is after to date."))
	if (end - f).days > MAX_RANGE_DAYS:
		frappe.throw(_("Pick a range of at most 3 years."))
	return key, f, end


# ── filters ─────────────────────────────────────────────────────────────────


def _company_where(params: dict, company: str) -> list[str]:
	params["company"] = company
	return [
		"si.docstatus = 1",
		"si.company = %(company)s",
		"coalesce(si.is_opening, 'No') != 'Yes'",
		_internal_customer_sql(),
	]


def _list_where(
	params: dict,
	company: str,
	f: date,
	t: date,
	search: str | None,
	customer: str | None,
	customer_group: str | None,
	returns_only,
) -> str:
	clauses = _company_where(params, company)
	params.update({"from": f, "to": t})
	clauses.append("si.posting_date between %(from)s and %(to)s")
	search = (search or "").strip()
	if search:
		params["search"] = f"%{search}%"
		clauses.append(
			"(si.name like %(search)s or si.customer like %(search)s or si.customer_name like %(search)s)"
		)
	if customer:
		params["customer"] = customer
		clauses.append("si.customer = %(customer)s")
	if customer_group:
		params["customer_group"] = customer_group
		clauses.append(f"{CUSTOMER_GROUP} = %(customer_group)s")
	if cint(returns_only):
		clauses.append("si.is_return = 1")
	return " and ".join(clauses)


# ── shaping ─────────────────────────────────────────────────────────────────


def _posting_iso(posting_date, posting_time) -> str:
	"""'YYYY-MM-DDTHH:MM:SS' (server-local, naive)."""
	d = str(posting_date)
	if posting_time is None:
		return f"{d}T00:00:00"
	if isinstance(posting_time, timedelta):
		secs = int(posting_time.total_seconds())
		return f"{d}T{secs // 3600:02d}:{(secs % 3600) // 60:02d}:{secs % 60:02d}"
	return f"{d}T{str(posting_time).split('.')[0]}"


def _margin(sale: float, cogs: float) -> float | None:
	"""Range margin (KPI): None below the dashboard's ₹1,000 revenue floor."""
	return _pct(sale - cogs, sale)


def _invoice_margin(sale: float, cogs: float) -> float | None:
	"""One invoice's margin. No ₹1,000 floor — a small retail bill still has a real margin."""
	if abs(sale) < 0.01:
		return None
	return (sale - cogs) / sale * 100


def _invoice_cogs(names: list[str]) -> dict[str, dict]:
	"""Per invoice: line count, COGS and ex-tax sale of valued lines, missing / flagged."""
	if not names:
		return {}
	rows = frappe.db.sql(
		f"""
		select x.parent as invoice, {LINE_AGGREGATES}
		from {_lines_subquery("sii.parent in %(names)s")}
		group by x.parent
		""",
		{"names": tuple(names)},
		as_dict=True,
	)
	return {r.invoice: r for r in rows}


def _row(si: dict, agg: dict | None, tax_mode: str) -> dict:
	agg = agg or frappe._dict(line_count=0, cogs=0, valued_sale=0, valued=0, missing=0, flagged=0)
	sale = flt(si.base_grand_total) if tax_mode == "incl" else flt(si.base_net_total)
	valued = cint(agg.valued) > 0
	return {
		"name": si.name,
		"posting_date": str(si.posting_date),
		"posted_at": _posting_iso(si.posting_date, si.posting_time),
		"customer": si.customer,
		"customer_name": si.customer_name,
		"customer_group": si.customer_group,
		"is_return": cint(si.is_return),
		"item_count": cint(agg.line_count),
		"sale_total": sale,
		"net_total": flt(si.base_net_total),
		"cogs_total": flt(agg.cogs) if valued else None,
		"lines_without_cogs": cint(agg.missing),
		"lines_flagged": cint(agg.flagged),
		"margin_pct": _invoice_margin(flt(agg.valued_sale), flt(agg.cogs)) if valued else None,
		"url": desk_url("Sales Invoice", si.name),
	}


SI_FIELDS = f"""
	si.name, si.posting_date, si.posting_time, si.customer,
	{CUSTOMER_NAME} as customer_name, {CUSTOMER_GROUP} as customer_group,
	si.is_return, si.base_net_total, si.base_grand_total
"""


# ── detail ──────────────────────────────────────────────────────────────────


def _invoice_detail(name: str, tax_mode: str) -> dict:
	si = frappe.db.sql(
		f"""
		select {SI_FIELDS}, si.company, si.return_against, si.currency,
		       si.base_total_taxes_and_charges, si.base_discount_amount, si.base_rounding_adjustment,
		       si.base_rounded_total
		from {SI_FROM}
		where si.name = %(name)s and si.docstatus = 1
		""",
		{"name": name},
		as_dict=True,
	)
	if not si:
		frappe.throw(
			_("Sales Invoice {0} not found or not submitted.").format(name), frappe.DoesNotExistError
		)
	si = si[0]
	is_return = bool(cint(si.is_return))
	lines = frappe.db.sql(
		f"""
		select sii.idx, sii.item_code, sii.item_name, sii.qty, sii.uom, sii.stock_qty,
		       sii.conversion_factor, sii.base_net_rate, sii.base_net_amount,
		       nullif(sii.incoming_rate, 0) as si_rate, nullif(dni.incoming_rate, 0) as dn_rate,
		       {"(" + LINE_COST + ")" if is_return else "null"} as booked,
		       {INCL_FACTOR} as incl_factor
		from {LINE_FROM}
		where sii.parent = %(name)s
		order by sii.idx
		""",
		{"name": name},
		as_dict=True,
	)
	out_lines = []
	qty_total = sale_total = cogs_total = valued_sale = 0.0
	missing = flagged = 0
	for ln in lines:
		factor = flt(ln.incl_factor) if tax_mode == "incl" else 1.0
		conv = flt(ln.conversion_factor) or 1.0
		qty = flt(ln.qty)
		net_rate = flt(ln.base_net_rate)
		net_amount = flt(ln.base_net_amount)
		if is_return:
			cogs_amount = flt(ln.booked) if ln.booked is not None else None
			cogs_rate = cogs_amount / qty if cogs_amount is not None and qty else None
			source = "stock_ledger" if cogs_amount is not None else None
		else:
			incoming = flt(ln.si_rate or ln.dn_rate) or None
			stock_qty = flt(ln.stock_qty) or qty * conv
			cogs_rate = incoming * conv if incoming else None
			cogs_amount = incoming * stock_qty if incoming else None
			source = "invoice" if ln.si_rate else ("delivery_note" if ln.dn_rate else None)
		line_flagged = _is_flagged(cogs_amount, net_amount)
		amount = net_amount * factor
		qty_total += qty
		sale_total += amount
		if cogs_amount is None:
			missing += 1
		elif line_flagged:
			flagged += 1
		else:
			cogs_total += cogs_amount
			valued_sale += net_amount
		out_lines.append(
			{
				"idx": cint(ln.idx),
				"item_code": ln.item_code,
				"item_name": ln.item_name or ln.item_code,
				"qty": qty,
				"uom": ln.uom,
				"sale_rate": net_rate * factor,
				"cogs_rate": cogs_rate,
				"cogs_source": source,
				"amount": amount,
				"cogs_amount": cogs_amount,
				"flagged": line_flagged,
				# Rate-based, ex-tax: (sale rate - COGS rate) / sale rate.
				"margin_pct": ((net_rate - cogs_rate) / net_rate * 100)
				if cogs_rate is not None and net_rate
				else None,
			}
		)
	valued = len(out_lines) > missing + flagged
	cogs = cogs_total if valued else None
	margin = _invoice_margin(valued_sale, cogs_total) if valued else None
	return {
		**_row(si, None, tax_mode),
		"item_count": len(out_lines),
		"company": si.company,
		"return_against": si.return_against,
		"lines": out_lines,
		"totals": {
			"qty": qty_total,
			"amount": sale_total,
			"cogs": cogs,
			# Ex-tax, over valued unflagged lines (same basis as the margin).
			"gross_profit": (valued_sale - cogs_total) if valued else None,
			"margin_pct": margin,
			"lines_without_cogs": missing,
			"lines_flagged": flagged,
			"net_total": flt(si.base_net_total),
			"taxes": flt(si.base_total_taxes_and_charges),
			"discount": flt(si.base_discount_amount),
			"rounding": flt(si.base_rounding_adjustment),
			"grand_total": flt(si.base_rounded_total) or flt(si.base_grand_total),
		},
		"cogs_total": cogs,
		"lines_without_cogs": missing,
		"lines_flagged": flagged,
		"margin_pct": margin,
	}


# ── API ─────────────────────────────────────────────────────────────────────


def _tax_mode(tax_mode: str | None) -> str:
	return tax_mode if tax_mode in TAX_MODES else "excl"


@frappe.whitelist()
def get_invoice_feed(
	company: str | None = None,
	tax_mode: str = "excl",
	range_key: str | None = None,
	from_date: str | None = None,
	to_date: str | None = None,
	search: str | None = None,
	customer: str | None = None,
	customer_group: str | None = None,
	returns_only: int = 0,
	start: int = 0,
	page_length: int = 20,
) -> dict:
	"""The newest invoice (ignores filters), KPIs for the filtered range, and one page of the
	filtered list, newest first."""
	_require_dashboard_access()
	_rate_limit("feed", FEED_LIMIT_PER_MIN)
	company = _resolve_company(company)
	tax_mode = _tax_mode(tax_mode)
	key, f, t = _resolve_range(company, range_key, from_date, to_date)
	start, page_length = max(cint(start), 0), min(max(cint(page_length), 1), MAX_PAGE)

	latest_name = _latest_invoice_name(company)
	latest = _invoice_detail(latest_name, tax_mode) if latest_name else None

	filters = {
		"company": company,
		"tax_mode": tax_mode,
		"key": key,
		"from": str(f),
		"to": str(t),
		"search": (search or "").strip(),
		"customer": customer or "",
		"customer_group": customer_group or "",
		"returns_only": cint(returns_only),
		"start": start,
		"page_length": page_length,
	}
	listing = _cached_listing(filters)
	return {
		"company": company,
		"tax_mode": tax_mode,
		"range": {"key": key, "from": str(f), "to": str(t)},
		"server_time": now_datetime().isoformat(timespec="seconds"),
		"latest": latest,
		**listing,
		"report_url": "/app/query-report/Sales%20Register?"
		+ urlencode({"company": company, "from_date": str(f), "to_date": str(t)}),
	}


def _latest_invoice_name(company: str) -> str | None:
	"""Newest submitted invoice of the company. Two steps so the posting_date index does the
	work: the newest date first (a backward index scan that stops at the first match), then
	the newest invoice of that day."""
	params: dict = {}
	where = " and ".join(_company_where(params, company))
	day = frappe.db.sql(
		f"select si.posting_date from {SI_FROM} where {where} order by si.posting_date desc limit 1",
		params,
	)
	if not day:
		return None
	params["day"] = day[0][0]
	name = frappe.db.sql(
		f"select si.name from {SI_FROM} where {where} and si.posting_date = %(day)s "
		f"order by {NEWEST_FIRST} limit 1",
		params,
	)
	return name[0][0] if name else None


def _cached_listing(filters: dict) -> dict:
	"""KPIs + one page + filter options, cached under the submit/cancel counter."""
	digest = hashlib.sha1(json.dumps(filters, sort_keys=True, default=str).encode()).hexdigest()
	cache = frappe.cache()
	key = f"company_dashboard|invoice_feed|{_ledger_counter(cache)}|{digest}"
	# expires=True: don't memoise a miss in the request-local cache (set_value with an expiry
	# doesn't overwrite it, so a later read in the same process would miss again).
	hit = cache.get_value(key, expires=True)
	if hit is not None:
		return copy.deepcopy(hit)
	data = _compute_listing(filters)
	cache.set_value(key, data, expires_in_sec=CACHE_TTL)
	return copy.deepcopy(data)


def _ledger_counter(cache) -> str:
	"""The submit/cancel counter half of report_cache's data version. Its other half (last
	completed repost) costs a table scan on every call; a repost is picked up when the
	cache entry expires instead (CACHE_TTL)."""
	value = cache.get(cache.make_key(_VERSION_KEY))
	return value.decode() if isinstance(value, bytes) else str(value or 0)


def _compute_listing(fl: dict) -> dict:
	company, tax_mode = fl["company"], fl["tax_mode"]
	f, t = getdate(fl["from"]), getdate(fl["to"])
	start, page_length = fl["start"], fl["page_length"]
	params: dict = {}
	where = _list_where(
		params, company, f, t, fl["search"], fl["customer"], fl["customer_group"], fl["returns_only"]
	)
	sale_expr = "si.base_grand_total" if tax_mode == "incl" else "si.base_net_total"
	head = frappe.db.sql(
		f"""
		select count(*) as invoice_count,
		       coalesce(sum({sale_expr}), 0) as sales,
		       sum(case when si.posting_date = %(today)s then 1 else 0 end) as today_count,
		       sum(case when si.is_return = 1 then 1 else 0 end) as return_count
		from {SI_FROM} where {where}
		""",
		{**params, "today": getdate(today())},
		as_dict=True,
	)[0]
	cost = frappe.db.sql(
		f"select {LINE_AGGREGATES} from {_lines_subquery(where)}",
		params,
		as_dict=True,
	)[0]

	page = frappe.db.sql(
		f"select {SI_FIELDS} from {SI_FROM} where {where} order by {NEWEST_FIRST} "
		"limit %(limit)s offset %(offset)s",
		{**params, "limit": page_length, "offset": start},
		as_dict=True,
	)
	aggs = _invoice_cogs([r.name for r in page])
	rows = [_row(r, aggs.get(r.name), tax_mode) for r in page]

	# Dropdown options for the range (customer filters stay valid while you page).
	opt_params: dict = {}
	opt_where = _list_where(opt_params, company, f, t, None, None, None, 0)
	customers = frappe.db.sql(
		f"""
		select si.customer as value, max({CUSTOMER_NAME}) as label
		from {SI_FROM} where {opt_where}
		group by si.customer order by label limit {CUSTOMER_OPTIONS_LIMIT}
		""",
		opt_params,
		as_dict=True,
	)
	# Leaf customer groups (the value an invoice carries). Scanning the invoices for the
	# groups in range costs a full table pass; the master list is a few rows.
	groups = frappe.get_all("Customer Group", filters={"is_group": 0}, pluck="name", order_by="name")

	valued = cint(cost.valued) > 0
	return {
		"kpi": {
			"invoice_count": cint(head.invoice_count),
			"today_count": cint(head.today_count),
			"return_count": cint(head.return_count),
			"sales": flt(head.sales),
			"cogs": flt(cost.cogs) if valued else None,
			"margin_pct": _margin(flt(cost.valued_sale), flt(cost.cogs)) if valued else None,
			"line_count": cint(cost.line_count),
			"lines_without_cogs": cint(cost.missing),
			"lines_flagged": cint(cost.flagged),
		},
		"rows": rows,
		"total_count": cint(head.invoice_count),
		"start": start,
		"page_length": page_length,
		"filters": {
			"customers": customers,
			"customer_groups": groups,
			"customers_truncated": len(customers) >= CUSTOMER_OPTIONS_LIMIT,
		},
	}


@frappe.whitelist()
def get_invoice_detail(name: str, tax_mode: str = "excl") -> dict:
	"""One invoice with its lines (dialog). The invoice's company must be one the user may view."""
	_require_dashboard_access()
	_rate_limit("detail", DETAIL_LIMIT_PER_MIN)
	company = frappe.db.get_value("Sales Invoice", name, "company")
	if not company:
		frappe.throw(_("Sales Invoice {0} not found.").format(name), frappe.DoesNotExistError)
	_resolve_company(company)  # raises PermissionError for a company the user can't view
	return _invoice_detail(name, _tax_mode(tax_mode))
