"""MIS dashboard API — real ERPNext metrics.

Rules (this file is the single source of truth — keep the UI labels in sync):

- **Totals come from the GL.** Every P&L line below revenue is a GL figure for the
  company and period (Period Closing Vouchers excluded, default finance book only).
  Cost of goods = every ``Cost of Goods Sold`` and ``Stock Adjustment`` account. Any
  P&L account not mapped to a bucket lands in "Other expenses" / "Other income", so
  **PAT always equals GL net profit** (the response carries the residual to prove it).
- **Revenue** is Sales Invoice lines, tax-exclusive (``base_net_amount``) in company
  currency, **net of returns** (credit notes carry negative amounts and quantities),
  booked to the configured Sales accounts, external customers only. Any difference to
  the GL sales accounts is shown inside "Other income".
- **Splits use the stock ledger.** B2C/B2B, SKU and segment cost is each line's posted
  stock value (``−Σ stock_value_difference`` of the Sales Invoice or Delivery Note line).
  The GL cost of goods not tied to a line (stock adjustments, JV/PI/PR/SE cost, flagged
  lines, timing) is "unallocated cost of goods": on the overview it is shared by revenue,
  on the SKU and segment pages it is a separate row. Splits therefore always sum to totals.
- **Margins are always tax-exclusive.** Tax mode changes the revenue column only.
- **Impossible lines are flagged, not counted.** A line whose cost is > 5× its revenue,
  or whose unit cost is > 10× the item's median, is kept out of the split until reviewed.
- **B2C vs B2B** is ``Item.custom_sales_intent`` (``B2C*`` / ``B2B*``); anything else is
  "unclassified", which is returned at every tier.
- **Internal transfers are excluded**: customers with ``is_internal_customer`` or
  ``is_bns_internal_customer``.
- **Comparisons** are against the same dates one year earlier, with a flag saying
  whether the site has data for that whole window.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from statistics import median
from typing import NamedTuple

import frappe
from frappe import _
from frappe.utils import add_months, flt, getdate, sbool, today

from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
	_SEED_MAP,
	COGS_ACCOUNT_TYPES,
	PL_INCOME_ALLOWED_FIELDS,
	get_account_meta,
	get_configured_accounts,
	get_mrp_price_list,
	get_segment_root_map,
)

MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

TOP_N_CATEGORIES = 10
BUCKETS = ("b2c", "b2b", "unclassified")

# Margins on less revenue than this are noise (a ₹0 SKU at −28,301,156%) — return null.
MIN_REVENUE_FOR_PCT = 1_000.0
# Line-level sanity guard (P7). A line is flagged when its stock cost is ≥ ANOMALY_MIN_COST
# and either > ANOMALY_COST_TO_REVENUE × its revenue, or its unit cost is
# > ANOMALY_UNIT_COST_TO_MEDIAN × the item's median unit cost (items with ≥ 3 lines).
ANOMALY_MIN_COST = 500.0
ANOMALY_COST_TO_REVENUE = 5.0
ANOMALY_UNIT_COST_TO_MEDIAN = 10.0
ANOMALY_LIST_LIMIT = 50

# Strict allow-list. ``System Manager`` is kept because Frappe System Managers always
# have implicit god access to the bench and can re-assign roles anyway — listing them
# here is just for transparency. Anyone else needs the explicit ``MIS Viewer`` role
# (auto-created by ``ensure_mis_viewer_role``) to view /mis or call the MIS APIs.
MIS_ACCESS_ROLES = frozenset({"System Manager", "MIS Viewer"})
WC_ACCESS_ROLES = frozenset({"System Manager", "WC Viewer"})
DASHBOARD_ACCESS_ROLES = MIS_ACCESS_ROLES | WC_ACCESS_ROLES


def has_dashboard_permission():
	"""Used by ``add_to_apps_screen`` to decide if the tile shows."""
	user = frappe.session.user
	if user == "Administrator":
		return True
	return bool(set(frappe.get_roles(user)) & DASHBOARD_ACCESS_ROLES)


# Keep old name as alias for backward compat with any external callers.
has_mis_permission = has_dashboard_permission


def _require_dashboard_access():
	"""Throw PermissionError unless caller has any dashboard role (MIS or WC)."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	if user == "Administrator":
		return
	if not (set(frappe.get_roles(user)) & DASHBOARD_ACCESS_ROLES):
		frappe.throw(
			_("You need one of these roles to access the dashboard: {0}").format(
				", ".join(sorted(DASHBOARD_ACCESS_ROLES))
			),
			frappe.PermissionError,
		)


def _require_mis_access():
	"""Throw PermissionError unless caller has MIS access."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	if user == "Administrator":
		return
	if not (set(frappe.get_roles(user)) & MIS_ACCESS_ROLES):
		frappe.throw(
			_("You need one of these roles to view MIS: {0}").format(", ".join(sorted(MIS_ACCESS_ROLES))),
			frappe.PermissionError,
		)


def _require_wc_access():
	"""Throw PermissionError unless caller has Working Capital access."""
	user = frappe.session.user
	if user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)
	if user == "Administrator":
		return
	if not (set(frappe.get_roles(user)) & WC_ACCESS_ROLES):
		frappe.throw(
			_("You need one of these roles to view Working Capital: {0}").format(
				", ".join(sorted(WC_ACCESS_ROLES))
			),
			frappe.PermissionError,
		)


def has_wc_access(user: str | None = None) -> bool:
	user = user or frappe.session.user
	if user == "Administrator":
		return True
	return bool(set(frappe.get_roles(user)) & WC_ACCESS_ROLES)


def _erpnext_installed() -> bool:
	return "erpnext" in frappe.get_installed_apps()


# ── Company ─────────────────────────────────────────────────────────────────


def _allowed_companies() -> set[str] | None:
	"""Companies the user is restricted to via User Permissions; None = unrestricted."""
	if frappe.session.user == "Administrator":
		return None
	from frappe.permissions import get_user_permissions

	rows = (get_user_permissions(frappe.session.user) or {}).get("Company") or []
	names = {r.get("doc") for r in rows if r.get("doc")}
	return names or None


def _resolve_company(company: str | None = None) -> str:
	"""Validated company for a request. Explicit ``company`` must exist and be allowed for
	the user; otherwise the user default, then the global default, then the first company."""
	allowed = _allowed_companies()
	if company:
		if not frappe.db.exists("Company", company):
			frappe.throw(_("Company {0} does not exist.").format(company))
		if allowed is not None and company not in allowed:
			frappe.throw(_("You are not allowed to view {0}.").format(company), frappe.PermissionError)
		return company
	for candidate in (
		frappe.defaults.get_user_default("Company"),
		frappe.defaults.get_global_default("company"),
	):
		if candidate and frappe.db.exists("Company", candidate) and (allowed is None or candidate in allowed):
			return candidate
	if allowed:
		return sorted(allowed)[0]
	names = frappe.get_all("Company", pluck="name", order_by="creation asc", limit=1)
	if not names:
		frappe.throw(_("No Company is set up on this site."))
	return names[0]


# Kept for callers that predate the ``company`` parameter.
def _default_company() -> str:
	return _resolve_company(None)


@frappe.whitelist()
def get_companies() -> list[str]:
	"""Companies the user may pick in the dashboard."""
	_require_dashboard_access()
	allowed = _allowed_companies()
	names = frappe.get_all("Company", pluck="name", order_by="company_name asc")
	return [n for n in names if allowed is None or n in allowed]


# ── Period ──────────────────────────────────────────────────────────────────


@dataclass
class Period:
	from_date: date
	to_date: date
	prior_from: date
	prior_to: date
	label: str
	kind: str  # "ttm" | "fy" | "custom"


def _shift_year(d: date, is_end: bool) -> date:
	"""Same date one year earlier. A month-end stays a month-end (29 Feb ↔ 28 Feb)."""
	shifted = getdate(add_months(d, -12))
	if is_end and d.day == calendar.monthrange(d.year, d.month)[1]:
		shifted = shifted.replace(day=calendar.monthrange(shifted.year, shifted.month)[1])
	return shifted


def _build_period(from_date: date, to_date: date, kind: str, label: str) -> Period:
	return Period(
		from_date,
		to_date,
		_shift_year(from_date, is_end=False),
		_shift_year(to_date, is_end=True),
		label,
		kind,
	)


def _ttm_window(anchor: date | None = None) -> Period:
	"""Last 12 calendar months: the 1st of the month 11 months back through today (the
	current month is month-to-date, never future days)."""
	ref = anchor or getdate(today())
	from_date = getdate(add_months(ref.replace(day=1), -11))
	label = f"Last 12 months · {from_date.strftime('%b %Y')} – {ref.strftime('%d %b %Y')}"
	return _build_period(from_date, ref, "ttm", label)


def _custom_window(from_date: date, to_date: date) -> Period:
	"""User-selected range. Named fiscal years get their name as the label."""
	if to_date < from_date:
		from_date, to_date = to_date, from_date
	fy = frappe.db.get_value(
		"Fiscal Year", {"year_start_date": from_date, "year_end_date": to_date, "disabled": 0}, "name"
	)
	if fy:
		return _build_period(from_date, to_date, "fy", f"FY {fy}")
	label = f"{from_date.strftime('%d %b %Y')} – {to_date.strftime('%d %b %Y')}"
	return _build_period(from_date, to_date, "custom", label)


def _period_for(from_date: str | None, to_date: str | None) -> Period:
	if from_date and to_date:
		return _custom_window(getdate(from_date), getdate(to_date))
	return _ttm_window()


def _ttm_cache_anchor(from_date: str | None, to_date: str | None) -> dict:
	"""Cache-key fragment pinning the default window to today's date (the window ends
	today). Explicit ranges are already in the key."""
	if from_date and to_date:
		return {}
	return {"ttm_anchor": getdate(today()).isoformat()}


def _sales_data_start(company: str) -> date | None:
	"""First submitted Sales Invoice date for the company (cached for an hour)."""
	key = f"company_dashboard|sales_data_start|{company}"
	cached = frappe.cache().get_value(key, expires=True)
	if cached:
		return getdate(cached)
	row = frappe.db.sql(
		"select min(posting_date) from `tabSales Invoice` where company = %s and docstatus = 1", company
	)
	start = row[0][0] if row and row[0][0] else None
	if start:
		frappe.cache().set_value(key, start.isoformat(), expires_in_sec=3600)
	return getdate(start) if start else None


def _period_dict(period: Period, company: str) -> dict:
	"""Period + prior-window coverage, so the UI can hide comparisons that aren't fair."""
	start = _sales_data_start(company)
	days = (period.prior_to - period.prior_from).days + 1
	if start is None or period.prior_to < start:
		covered = 0
	elif period.prior_from >= start:
		covered = days
	else:
		covered = (period.prior_to - start).days + 1
	coverage = round(covered / days * 100, 1) if days > 0 else 0.0
	month_end = calendar.monthrange(period.to_date.year, period.to_date.month)[1]
	return {
		"from": period.from_date.isoformat(),
		"to": period.to_date.isoformat(),
		"label": period.label,
		"kind": period.kind,
		"days": (period.to_date - period.from_date).days + 1,
		"is_12_months": _is_12_months(period),
		"last_month_partial": period.to_date.day != month_end,
		"comparison_label": _("vs same period last year"),
		"prior": {
			"from": period.prior_from.isoformat(),
			"to": period.prior_to.isoformat(),
			"available": coverage >= 100.0,
			"coverage_pct": coverage,
			"data_starts": start.isoformat() if start else None,
		},
	}


def _is_12_months(period: Period) -> bool:
	nxt = getdate(add_months(period.from_date, 12))
	return abs((nxt - period.to_date).days) <= 31


# ── SQL building blocks ─────────────────────────────────────────────────────

SII_BASE_FROM = """
	`tabSales Invoice Item` sii
	join `tabSales Invoice`   si on si.name = sii.parent
	left join `tabItem`       i  on i.name  = sii.item_code
	left join `tabCustomer`   c  on c.name  = si.customer
"""

# Line amount expressions. Tax-inclusive pro-rates the invoice's grand total back to each
# line by its share of net_total (returns included: both totals are negative there).
AMT_EXCL = "sii.base_net_amount"
AMT_INCL = (
	"sii.base_net_amount * case when si.base_net_total != 0 "
	"then si.base_grand_total / si.base_net_total else 1 end"
)
TAX_MODES = ("incl", "excl")

# Stock-ledger cost of one Sales Invoice line (NULL = no stock movement, i.e. unvalued):
#  - SI with update_stock: the SI line's own stock ledger entries;
#  - billed from a DN line: that DN line's entries, pro-rated by the billed quantity;
#  - DN made against the SI: the DN lines pointing back at this SI line.
# Cancelled entries are excluded. Reposts update these values, unlike sii.incoming_rate.
# Stock-ledger cost of one Sales Invoice line (NULL = unvalued):
#  - SI with update_stock: the SI line's own stock ledger entries;
#  - billed from a DN line: that DN line's entries, pro-rated by billed quantity. A credit
#    note pointing at an ordinary (non-return) DN line moved no stock, so it is unvalued;
#  - DN made against the SI: the DN lines pointing back at this SI line;
#  - SO billed and delivered separately: the average cost per unit of the SO line's
#    deliveries × billed quantity (what ERPNext's Gross Profit report does).
# Cancelled entries are excluded. Reposts update these values, unlike sii.incoming_rate.
# Lines whose cost posts to an account that isn't cost of goods (e.g. samples booked to
# Marketing) are unvalued here: the GL already counts that cost in its own bucket.
LINE_COST_JOINS = """
	left join `tabDelivery Note Item` dni on dni.name = sii.dn_detail
	left join `tabAccount` ea on ea.name = coalesce(nullif(dni.expense_account, ''), sii.expense_account)
"""
LINE_COST = """
	case
		when si.update_stock = 1 then (
			select -sum(sle.stock_value_difference)
			from `tabStock Ledger Entry` sle
			where sle.voucher_detail_no = sii.name and sle.voucher_type = 'Sales Invoice'
			  and sle.voucher_no = si.name and sle.is_cancelled = 0
		)
		when coalesce(sii.dn_detail, '') != '' then
			case when sii.stock_qty < 0 and coalesce(dni.stock_qty, 0) > 0 then null else (
				select -sum(sle.stock_value_difference)
				from `tabStock Ledger Entry` sle
				where sle.voucher_detail_no = sii.dn_detail and sle.voucher_type = 'Delivery Note'
				  and sle.is_cancelled = 0
			) * case when coalesce(dni.stock_qty, 0) != 0 then sii.stock_qty / dni.stock_qty else 1 end end
		else coalesce(
			(
				select -sum(sle.stock_value_difference)
				from `tabDelivery Note Item` d
				join `tabStock Ledger Entry` sle
				  on sle.voucher_type = 'Delivery Note' and sle.voucher_detail_no = d.name and sle.is_cancelled = 0
				where d.si_detail = sii.name and d.docstatus = 1
			),
			case when sii.stock_qty > 0 and coalesce(sii.so_detail, '') != '' then (
				select -sum(sle.stock_value_difference)
				from `tabDelivery Note Item` d
				join `tabStock Ledger Entry` sle
				  on sle.voucher_type = 'Delivery Note' and sle.voucher_detail_no = d.name and sle.is_cancelled = 0
				where d.so_detail = sii.so_detail and d.docstatus = 1 and d.stock_qty > 0
				  and coalesce(d.si_detail, '') = ''
			) / (
				select nullif(sum(d.stock_qty), 0)
				from `tabDelivery Note Item` d
				where d.so_detail = sii.so_detail and d.docstatus = 1 and d.stock_qty > 0
				  and coalesce(d.si_detail, '') = ''
			) * sii.stock_qty end
		)
	end
"""
COGS_TYPES_SQL = "('Cost of Goods Sold', 'Stock Adjustment')"


def _intent_col() -> str:
	"""``Item.custom_sales_intent`` when the site has it, else NULL (all unclassified)."""
	return "i.custom_sales_intent" if frappe.db.has_column("Item", "custom_sales_intent") else "null"


def _intent_bucket_sql(alias: str = "bucket") -> str:
	col = _intent_col()
	return (
		f"case when {col} like 'B2C%%' then 'b2c' when {col} like 'B2B%%' then 'b2b' "
		f"else 'unclassified' end as {alias}"
	)


def _internal_customer_sql() -> str:
	parts = ["coalesce(c.is_internal_customer, 0) = 0"]
	if frappe.db.has_column("Customer", "is_bns_internal_customer"):
		parts.append("coalesce(c.is_bns_internal_customer, 0) = 0")
	return "(" + " and ".join(parts) + ")"


def _sales_accounts() -> list[str]:
	return get_configured_accounts("sales_income_accounts")


def _base_where(params: dict, company: str, from_date: date, to_date: date, internal: bool = False) -> str:
	"""WHERE clause every revenue query shares. Returns are included (they net out)."""
	params.update({"company": company, "from": from_date, "to": to_date})
	clauses = [
		"si.docstatus = 1",
		"coalesce(si.is_opening, 'No') != 'Yes'",
		"si.company = %(company)s",
		"si.posting_date between %(from)s and %(to)s",
		f"not {_internal_customer_sql()}" if internal else _internal_customer_sql(),
	]
	sales = _sales_accounts()
	if sales:
		params["sales_accounts"] = tuple(sales)
		clauses.append("sii.income_account in %(sales_accounts)s")
	return " and ".join(clauses)


def _segment_sql() -> str:
	"""Customer group as it was on the invoice, falling back to today's group."""
	return "coalesce(nullif(si.customer_group, ''), c.customer_group, '(unassigned)')"


def _pct(num: float | None, den: float | None) -> float | None:
	"""num / den × 100, or None when the denominator is too small to mean anything."""
	if num is None or den is None or abs(den) < MIN_REVENUE_FOR_PCT:
		return None
	return num / den * 100


# ── Line-level sales (single source for every split) ───────────────────────


class SalesLine(NamedTuple):
	invoice: str
	item_code: str
	item_name: str
	item_group: str
	intent: str | None
	bucket: str
	is_stock_item: int
	stock_uom: str
	customer: str
	customer_name: str
	segment: str
	month: str  # "YYYY-MM"
	rev_excl: float
	rev_incl: float
	stock_qty: float
	cost: float | None  # stock-ledger cost; None = no stock movement
	flagged: bool
	income_account: str = ""

	def rev(self, mode: str) -> float:
		return self.rev_incl if mode == "incl" else self.rev_excl

	@property
	def allocated_cost(self) -> float:
		"""Cost counted in splits: unvalued and flagged lines contribute nothing."""
		return 0.0 if (self.cost is None or self.flagged) else self.cost

	@property
	def valued(self) -> bool:
		return self.cost is not None and not self.flagged


def _sales_lines(company: str, from_date: date, to_date: date) -> list[SalesLine]:
	"""Every external Sales Invoice line in the window with its stock-ledger cost.
	Memoised per request — overview, SKU and segment exports share one fetch."""
	memo = getattr(frappe.local, "company_dashboard_lines", None)
	if memo is None:
		memo = frappe.local.company_dashboard_lines = {}
	key = (company, from_date, to_date, tuple(_sales_accounts()))
	if key in memo:
		return memo[key]

	params: dict = {}
	where = _base_where(params, company, from_date, to_date)
	raw = frappe.db.sql(
		f"""
		select
			si.name,
			sii.item_code,
			coalesce(i.item_name, sii.item_name, sii.item_code),
			coalesce(i.item_group, sii.item_group, 'Unclassified'),
			{_intent_col()},
			{_intent_bucket_sql()},
			coalesce(i.is_stock_item, 0),
			coalesce(nullif(sii.stock_uom, ''), i.stock_uom, ''),
			si.customer,
			coalesce(c.customer_name, si.customer_name, si.customer),
			{_segment_sql()},
			date_format(si.posting_date, '%%Y-%%m'),
			coalesce({AMT_EXCL}, 0),
			coalesce({AMT_INCL}, 0),
			coalesce(sii.stock_qty, 0),
			{LINE_COST},
			coalesce(ea.account_type, '') in {COGS_TYPES_SQL},
			coalesce(sii.income_account, '')
		from {SII_BASE_FROM}
		{LINE_COST_JOINS}
		where {where}
		""",
		params,
	)

	# Cost posted outside cost of goods is not part of the split (see LINE_COST).
	raw = [r if (r[15] is None or r[16]) else (*r[:15], None, *r[16:]) for r in raw]

	unit_costs: dict[str, list[float]] = defaultdict(list)
	for r in raw:
		cost, qty = r[15], flt(r[14])
		if cost is not None and qty and flt(cost) > 0:
			unit_costs[r[1]].append(abs(flt(cost)) / abs(qty))
	medians = {item: median(v) for item, v in unit_costs.items() if len(v) >= 3}

	lines: list[SalesLine] = []
	for r in raw:
		cost = None if r[15] is None else flt(r[15])
		rev_excl, qty = flt(r[12]), flt(r[14])
		flagged = False
		if cost is not None and abs(cost) >= ANOMALY_MIN_COST:
			if rev_excl and abs(cost) > ANOMALY_COST_TO_REVENUE * abs(rev_excl):
				flagged = True
			else:
				med = medians.get(r[1])
				if med and qty and abs(cost) / abs(qty) > ANOMALY_UNIT_COST_TO_MEDIAN * med:
					flagged = True
		lines.append(
			SalesLine(
				invoice=r[0],
				item_code=r[1],
				item_name=r[2],
				item_group=r[3],
				intent=r[4],
				bucket=r[5],
				is_stock_item=int(r[6] or 0),
				stock_uom=r[7] or "",
				customer=r[8],
				customer_name=r[9],
				segment=r[10],
				month=r[11],
				rev_excl=rev_excl,
				rev_incl=flt(r[13]),
				stock_qty=qty,
				cost=cost,
				flagged=flagged,
				income_account=r[17],
			)
		)
	memo[key] = lines
	return lines


def _coverage(lines) -> float | None:
	"""Share of positive (non-return) sales value whose cost is known. Warning only."""
	sold = sum(ln.rev_excl for ln in lines if ln.rev_excl > 0)
	valued = sum(ln.rev_excl for ln in lines if ln.rev_excl > 0 and ln.valued)
	return _pct(valued, sold)


def _anomalies(lines: list[SalesLine]) -> list[dict]:
	flagged = sorted((ln for ln in lines if ln.flagged), key=lambda ln: abs(ln.cost or 0), reverse=True)
	return [
		{
			"invoice": ln.invoice,
			"item_code": ln.item_code,
			"item_name": ln.item_name,
			"customer": ln.customer,
			"month": ln.month,
			"qty": ln.stock_qty,
			"revenue": ln.rev_excl,
			"cost": ln.cost,
			"unit_cost": (ln.cost / ln.stock_qty) if ln.stock_qty else None,
		}
		for ln in flagged[:ANOMALY_LIST_LIMIT]
	]


def _quality(lines: list[SalesLine]) -> dict:
	flagged = [ln for ln in lines if ln.flagged]
	return {
		"coverage_pct": _coverage(lines),
		"flagged_lines": len(flagged),
		"flagged_cost": sum(ln.cost or 0 for ln in flagged),
		"flagged_revenue": sum(ln.rev_excl for ln in flagged),
		"anomalies": _anomalies(lines),
		"rules": {
			"min_revenue_for_pct": MIN_REVENUE_FOR_PCT,
			"min_cost": ANOMALY_MIN_COST,
			"cost_to_revenue": ANOMALY_COST_TO_REVENUE,
			"unit_cost_to_median": ANOMALY_UNIT_COST_TO_MEDIAN,
		},
	}


def _revenue_by_bucket(company: str, from_date: date, to_date: date, mode: str) -> dict[str, float]:
	"""Revenue per bucket straight from SQL (used for the prior window)."""
	params: dict = {}
	amt = AMT_INCL if mode == "incl" else AMT_EXCL
	rows = frappe.db.sql(
		f"""
		select {_intent_bucket_sql()}, coalesce(sum({amt}), 0) as amt
		from {SII_BASE_FROM}
		where {_base_where(params, company, from_date, to_date)}
		group by bucket
		""",
		params,
		as_dict=True,
	)
	out = dict.fromkeys(BUCKETS, 0.0)
	for row in rows:
		out[row["bucket"]] = flt(row["amt"])
	out["total"] = sum(out[b] for b in BUCKETS)
	return out


def _unconfigured_income_warnings(company: str, period: Period) -> list[dict]:
	"""External Sales Invoice lines booked to income accounts that are not configured as
	Sales accounts — left out of revenue (they show in Other income). Nothing to warn
	about when no Sales accounts are configured (every income account counts)."""
	sales = _sales_accounts()
	if not sales:
		return []
	rows = frappe.db.sql(
		f"""
		select sii.income_account, coalesce(sum({AMT_EXCL}), 0) as amt
		from {SII_BASE_FROM}
		where si.docstatus = 1 and coalesce(si.is_opening, 'No') != 'Yes'
		  and si.company = %(company)s and si.posting_date between %(from)s and %(to)s
		  and {_internal_customer_sql()}
		  and sii.income_account not in %(sales)s
		group by sii.income_account
		having abs(coalesce(sum({AMT_EXCL}), 0)) >= 1
		order by abs(coalesce(sum({AMT_EXCL}), 0)) desc
		""",
		{"company": company, "from": period.from_date, "to": period.to_date, "sales": tuple(sales)},
		as_dict=True,
	)
	return [
		{
			"code": "unconfigured_income_account",
			"account": r.income_account,
			"message": _(
				"Sales Invoice lines worth {0} are booked to {1}, which is not a configured Sales account, so they count as Other income, not revenue."
			).format(frappe.format_value(flt(r.amt), {"fieldtype": "Currency"}), r.income_account),
		}
		for r in rows
	]


def _excluded_customer_stats(company: str, period: Period, mode: str) -> dict:
	"""How much revenue the internal-customer filter dropped."""
	params: dict = {}
	amt = AMT_INCL if mode == "incl" else AMT_EXCL
	rows = frappe.db.sql(
		f"""
		select count(distinct si.name) as invoices, coalesce(sum({amt}), 0) as amt
		from {SII_BASE_FROM}
		where {_base_where(params, company, period.from_date, period.to_date, internal=True)}
		""",
		params,
		as_dict=True,
	)
	if not rows:
		return {"invoices": 0, "amount": 0.0}
	return {"invoices": int(rows[0]["invoices"]), "amount": flt(rows[0]["amt"])}


# ── GL P&L ──────────────────────────────────────────────────────────────────

# (key, settings field, label) in ladder order.
PL_LINES: tuple[tuple[str, str, str], ...] = (
	("direct", "direct_cost_accounts", "Direct costs"),
	("freight", "outbound_freight_accounts", "Outbound freight"),
	("packaging", "packaging_overhead_accounts", "Packaging & dispatch"),
	("commission", "marketplace_commission_accounts", "Transaction fees & commissions"),
	("scheme", "trade_scheme_accounts", "Trade schemes & rebates"),
	("marketing", "marketing_accounts", "Marketing"),
	("salary", "salary_accounts", "Salary & payroll"),
	("rent", "rent_accounts", "Rent & lease"),
	("utility", "utility_accounts", "Utilities & communications"),
	("admin", "admin_overhead_accounts", "Admin & general overhead"),
	("da", "depreciation_amortization_accounts", "Depreciation & amortization"),
	("interest", "interest_and_finance_accounts", "Interest & finance cost"),
	("tax", "tax_expense_accounts", "Income tax"),
)
PL_KEYS = tuple(k for k, _f, _l in PL_LINES)
VARIABLE_KEYS = ("freight", "packaging", "commission", "scheme")
OPERATING_KEYS = ("salary", "rent", "utility", "admin")


def _finance_book_clause(company: str, params: dict) -> str:
	"""Entries with no finance book plus the company's default book — what ERPNext's own
	financial statements show when no book is picked."""
	fb = frappe.get_cached_value("Company", company, "default_finance_book")
	if fb:
		params["finance_book"] = fb
		return "and (coalesce(ge.finance_book, '') = '' or ge.finance_book = %(finance_book)s)"
	return "and coalesce(ge.finance_book, '') = ''"


def _gl_pl_balances(company: str, from_date: date, to_date: date) -> dict[str, frappe._dict]:
	"""Net (debit − credit) per P&L account for the window. Excludes cancelled entries,
	opening entries and Period Closing Vouchers (which would zero every account).
	Memoised per request — an export builds three pages from the same window."""
	memo = getattr(frappe.local, "company_dashboard_gl", None)
	if memo is None:
		memo = frappe.local.company_dashboard_gl = {}
	key = (company, from_date, to_date)
	if key in memo:
		return memo[key]
	params: dict = {"company": company, "from": from_date, "to": to_date}
	fb = _finance_book_clause(company, params)
	rows = frappe.db.sql(
		f"""
		select ge.account, acc.root_type, acc.account_type, acc.account_name,
		       sum(ge.debit) - sum(ge.credit) as net
		from `tabGL Entry` ge
		join `tabAccount` acc on acc.name = ge.account
		where ge.company = %(company)s
		  and ge.posting_date between %(from)s and %(to)s
		  and ge.is_cancelled = 0
		  and coalesce(ge.is_opening, 'No') = 'No'
		  and ge.voucher_type != 'Period Closing Voucher'
		  and acc.root_type in ('Income', 'Expense')
		  {fb}
		group by ge.account, acc.root_type, acc.account_type, acc.account_name
		""",
		params,
		as_dict=True,
	)
	for r in rows:
		r.net = flt(r.net)
	memo[key] = {r.account: r for r in rows}
	return memo[key]


def _internal_pl_accounts() -> set[str]:
	"""Internal-transfer accounts: BNS branch-accounting ones plus the admin's
	``wc_internal_accounts``. Only their P&L rows are used here."""
	from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
		_bns_internal_accounts,
	)

	return set(_bns_internal_accounts()) | set(get_configured_accounts("wc_internal_accounts"))


def _seed_hint_matches(fieldname: str, account_name: str) -> bool:
	for field, include, exclude in _SEED_MAP:
		if field != fieldname:
			continue
		raw = (account_name or "").lower()
		return not any(x in raw for x in exclude) and any(h in raw for h in include)
	return False


def _pl_breakdown(
	company: str, period: Period | None, revenue_excl: float, balances: dict | None = None
) -> dict:
	"""Every P&L figure below revenue, from the GL. Mapping problems are reported as
	warnings and the account falls through to Other expenses / Other income, so the
	ladder still ties to GL net profit. ``balances`` (account → row with ``net``) may be
	passed in, e.g. one month of a statement; otherwise the period's are read."""
	if balances is None:
		balances = _gl_pl_balances(company, period.from_date, period.to_date)
	labels = {k: lbl for k, _f, lbl in PL_LINES}
	configured = {k: get_configured_accounts(f) for k, f, _l in PL_LINES}
	meta = get_account_meta({a for accs in configured.values() for a in accs} | set(_sales_accounts()))

	warnings: list[dict] = []
	assigned: dict[str, str] = {}
	for key, field, label in PL_LINES:
		roots = ("Expense", "Income") if field in PL_INCOME_ALLOWED_FIELDS else ("Expense",)
		for acc in configured[key]:
			m = meta.get(acc)
			if m and m.company and m.company != company:
				continue  # the settings singleton is shared by all companies
			reason = None
			if not m:
				reason = _("does not exist")
			elif m.is_group:
				reason = _("is a group account, which never has postings — map its leaf accounts")
			elif m.root_type not in roots:
				reason = _("has root type {0}, so it is not a P&L expense here — ignored").format(
					m.root_type or "(none)"
				)
			elif m.account_type in COGS_ACCOUNT_TYPES:
				reason = _("is already in cost of goods — ignored here")
			elif acc in assigned:
				reason = _("is also mapped in {0} — counted there only").format(labels[assigned[acc]])
			if reason:
				warnings.append(
					{
						"code": "bad_mapping",
						"bucket": key,
						"account": acc,
						"message": f"{label}: {acc} {reason}.",
					}
				)
				continue
			assigned[acc] = key

	totals = dict.fromkeys(PL_KEYS, 0.0)
	accounts = {k: [] for k in PL_KEYS}
	active = dict.fromkeys(PL_KEYS, False)
	for acc, key in assigned.items():
		accounts[key].append(acc)
		row = balances.get(acc)
		if row:
			totals[key] += row.net
			active[key] = True

	cogs_rows = [
		r for r in balances.values() if r.root_type == "Expense" and r.account_type in COGS_ACCOUNT_TYPES
	]
	# Internal-transfer P&L accounts (branch sales/purchase transfers) form their own line,
	# so they don't inflate Other income / Other expenses. Internal COGS stays in cost of
	# goods, as the audit's reconciliation counts it.
	internal = _internal_pl_accounts()
	internal_rows = [
		r
		for r in balances.values()
		if r.account in internal and r.account not in assigned and r.account_type not in COGS_ACCOUNT_TYPES
	]
	internal_names = {r.account for r in internal_rows}
	unmapped_rows = [
		r
		for r in balances.values()
		if r.root_type == "Expense"
		and r.account_type not in COGS_ACCOUNT_TYPES
		and r.account not in assigned
		and r.account not in internal_names
	]
	income_rows = [
		r
		for r in balances.values()
		if r.root_type == "Income" and r.account not in assigned and r.account not in internal_names
	]
	sales = set(_sales_accounts())

	cogs = sum(r.net for r in cogs_rows)
	internal_net = sum(r.net for r in internal_rows)
	unmapped_expense = sum(r.net for r in unmapped_rows)
	income_unassigned = -sum(r.net for r in income_rows)
	other_income = income_unassigned - revenue_excl
	sales_gl = -sum(r.net for r in income_rows if r.account in sales) if sales else None
	revenue_gl_difference = (sales_gl - revenue_excl) if sales_gl is not None else None
	gl_net_profit = -sum(r.net for r in balances.values())

	# P12: a bucket with no postings while similarly named unmapped accounts have some.
	for key, field, label in PL_LINES:
		if active[key]:
			continue
		lookalikes = [
			r for r in unmapped_rows + income_rows if r.net and _seed_hint_matches(field, r.account_name)
		]
		if lookalikes:
			names = ", ".join(r.account for r in sorted(lookalikes, key=lambda r: -abs(r.net))[:3])
			warnings.append(
				{
					"code": "empty_bucket",
					"bucket": key,
					"message": _(
						"{0} has no postings in this period, but unmapped accounts that look like it do: {1}."
					).format(label, names),
				}
			)

	def _top(rows: list, sign: int) -> list[dict]:
		return [
			{"account": r.account, "amount": sign * r.net}
			for r in sorted((r for r in rows if abs(r.net) >= 0.5), key=lambda r: -abs(r.net))[:15]
		]

	def _items(rows: list) -> list[dict]:
		"""Every account behind a line, signed as it moves the line (expense +)."""
		return [
			{"account": r.account, "amount": r.net, "root_type": r.root_type}
			for r in sorted(rows, key=lambda r: -abs(r.net))
			if abs(r.net) >= 0.005
		]

	line_accounts: dict[str, list[dict]] = {
		"cogs": _items(cogs_rows),
		"internal": _items(internal_rows),
	}
	for key in PL_KEYS:
		rows = [balances[a] for a in accounts[key] if a in balances]
		line_accounts[key] = _items(rows) + [
			{"account": a, "amount": 0.0, "root_type": None} for a in accounts[key] if a not in balances
		]
	# Other = unmapped expenses − (unmapped income − invoice-line revenue). The synthetic
	# row makes the listed amounts add up to the line exactly.
	if sales:
		other_items = _items(unmapped_rows) + _items([r for r in income_rows if r.account not in sales])
		other_items.append(
			{
				"account": None,
				"label": "Sales accounts in GL less invoice-line revenue",
				"amount": -(revenue_gl_difference or 0.0),
				"root_type": "Income",
			}
		)
	else:
		other_items = _items(unmapped_rows) + _items(income_rows)
		other_items.append(
			{
				"account": None,
				"label": "Less: revenue already counted from invoice lines",
				"amount": revenue_excl,
				"root_type": "Income",
			}
		)
	line_accounts["other"] = other_items

	return {
		"totals": totals,
		"accounts": accounts,
		"line_accounts": line_accounts,
		"cogs": cogs,
		"cogs_accounts": [{"account": r.account, "amount": r.net} for r in cogs_rows],
		"unmapped_expense": unmapped_expense,
		"unmapped_expense_accounts": _top(unmapped_rows, 1),
		"other_income": other_income,
		"other_income_accounts": _top([r for r in income_rows if r.account not in sales], -1),
		"internal_net": internal_net,
		"internal_accounts": _top(internal_rows, 1),
		"sales_gl": sales_gl,
		"revenue_gl_difference": revenue_gl_difference,
		"gl_net_profit": gl_net_profit,
		"warnings": warnings,
	}


def _ladder(rev_excl: dict[str, float], line_cost: dict[str, float], pl: dict) -> dict[str, dict]:
	"""CM1 → PAT for overall and each bucket.

	Overall cost of goods is the GL figure. A bucket gets its own stock-ledger line cost
	plus a revenue share of the unallocated remainder; every other GL line is shared by
	tax-exclusive revenue. Buckets therefore sum exactly to overall, and overall PAT
	equals GL net profit.
	"""
	total_rev = rev_excl["overall"]
	line_total = sum(line_cost[b] for b in BUCKETS)
	unallocated = pl["cogs"] - line_total
	t = pl["totals"]
	other_net = pl["unmapped_expense"] - pl["other_income"]
	internal_net = pl.get("internal_net", 0.0)

	def share(b: str) -> float:
		if b == "overall":
			return 1.0
		if total_rev:
			return rev_excl[b] / total_rev
		return 1.0 if b == "unclassified" else 0.0

	out: dict[str, dict] = {}
	for b in ("overall", *BUCKETS):
		s = share(b)
		rev = rev_excl[b]
		row = {"revenue": rev, "share": s}
		row["cogs_allocated"] = line_total if b == "overall" else line_cost[b]
		row["cogs_unallocated"] = unallocated * s
		row["cogs"] = row["cogs_allocated"] + row["cogs_unallocated"]
		for k in PL_KEYS:
			row[k] = t[k] * s
		row["other_expense"] = pl["unmapped_expense"] * s
		row["other_income"] = pl["other_income"] * s
		row["other_net"] = other_net * s
		row["internal"] = internal_net * s
		row["variable"] = sum(row[k] for k in VARIABLE_KEYS)
		row["operating"] = sum(row[k] for k in OPERATING_KEYS)
		row["cm1"] = rev - row["cogs"] - row["direct"]
		row["cm2"] = row["cm1"] - row["variable"]
		row["cm3"] = row["cm2"] - row["marketing"]
		row["ebitda"] = row["cm3"] - row["operating"] - row["other_net"] - row["internal"]
		row["ebit"] = row["ebitda"] - row["da"]
		row["pbt"] = row["ebit"] - row["interest"]
		row["pat"] = row["pbt"] - row["tax"]
		for tier in ("cm1", "cm2", "cm3", "ebitda", "ebit", "pbt", "pat"):
			row[f"{tier}_pct"] = _pct(row[tier], rev)
		out[b] = row
	return out


TIER_FORMULAS = {
	"cm1": "Revenue − Cost of goods − Direct costs",
	"cm2": "CM1 − Freight − Packaging − Transaction fees − Trade schemes",
	"cm3": "CM2 − Marketing",
	"ebitda": "CM3 − Salary − Rent − Utilities − Admin − Other (net) − Internal transfers (net)",
	"ebit": "EBITDA − Depreciation & amortization",
	"pbt": "EBIT − Interest & finance cost",
	"pat": "PBT − Income tax",
}
BUCKET_LABELS = {"overall": "all items", "b2c": "B2C", "b2b": "B2B", "unclassified": "unclassified"}


def _attach_sources(steps: list[dict], row: dict, pl: dict, bucket: str, revenue_sources: list[dict]) -> None:
	"""Explain every step: the formula, and the ledgers (or derived parts) that make it.

	Source amounts are signed as they move the line: for a cost line + adds cost, −
	(a credit, e.g. an income account netted in) reduces it. They always add up to the
	step's value. Bucket steps scale GL accounts by the bucket's revenue share, except
	revenue (exact, from its own invoice lines) and the stock-ledger part of cost of goods.
	"""
	share = row.get("share", 1.0)
	label = BUCKET_LABELS.get(bucket, bucket)
	line_accounts = pl.get("line_accounts") or {}
	prev_tier: dict | None = None
	since_tier: list[dict] = []
	for st in steps:
		key = st["key"]
		st["bucket"] = bucket
		if st["kind"] == "anchor":
			st["formula"] = "Σ invoice-line net amount (ex-tax, returns netted), by income account"
			st["sources"] = revenue_sources
			st["share"] = None
			prev_tier = st
			since_tier = []
			continue
		if st["kind"] == "tier":
			st["formula"] = TIER_FORMULAS.get(key, "")
			st["components"] = [
				{"key": prev_tier["key"], "label": prev_tier["label"], "amount": prev_tier["amount"]},
				*({"key": d["key"], "label": d["label"], "amount": d["amount"]} for d in since_tier),
			]
			st["sources"] = []
			st["share"] = None
			prev_tier = st
			since_tier = []
			continue
		since_tier.append(st)
		value = -st["amount"]
		if key == "cogs" and bucket != "overall":
			st["formula"] = (
				f"Stock-ledger cost of {label} invoice lines + {share * 100:.1f}% of unallocated cost of goods"
			)
			st["sources"] = [
				{
					"account": None,
					"label": f"Stock-ledger cost of {label} invoice lines",
					"amount": row["cogs_allocated"],
				},
				{
					"account": None,
					"label": f"Share of unallocated cost of goods ({share * 100:.1f}% revenue share)",
					"amount": row["cogs_unallocated"],
				},
			]
			st["share"] = share
			continue
		items = line_accounts.get(key) or []
		scale = 1.0 if bucket == "overall" else share
		st["sources"] = [{**it, "amount": it["amount"] * scale} for it in items]
		st["share"] = None if bucket == "overall" else share
		n = len([it for it in items if it.get("account")])
		base = (
			"Σ Cost of Goods Sold + Stock Adjustment accounts (debit − credit)"
			if key == "cogs"
			else f"Σ {n} GL account{'s' if n != 1 else ''} (debit − credit)"
		)
		if key == "other":
			base = "Unmapped expense accounts − unmapped income accounts + revenue reconciling difference"
		st["formula"] = base if bucket == "overall" else f"{base} × {share * 100:.1f}% revenue share"
		if key == "cogs":
			st["split"] = {"allocated": row["cogs_allocated"], "unallocated": row["cogs_unallocated"]}
		# Guard: rounding of scaled sources must not drift from the step value.
		drift = value - sum(it["amount"] for it in st["sources"])
		if abs(drift) >= 0.5:
			st["sources"].append({"account": None, "label": "Rounding / unlisted", "amount": drift})


def _pnl_steps(
	row: dict, pl: dict, bucket: str = "overall", revenue_sources: list[dict] | None = None
) -> list[dict]:
	"""Waterfall steps for one bucket, ex-tax. Deductions are negative; ``subtotal`` is the
	running total after the step, so the last step equals PAT. Each step carries its
	formula and the ledgers behind it (see ``_attach_sources``)."""
	accounts = pl["accounts"]
	steps: list[dict] = []
	running = row["revenue"]
	steps.append(
		{
			"key": "revenue",
			"label": "Revenue",
			"kind": "anchor",
			"amount": running,
			"subtotal": running,
			"note": "ex-tax, net of returns",
			"group": None,
		}
	)

	def n_accounts(key: str) -> str:
		n = len(accounts.get(key) or [])
		return f"{n} account{'s' if n != 1 else ''}"

	def deduct(key: str, label: str, amount: float, note: str, group: str | None = None) -> None:
		nonlocal running
		running -= amount
		steps.append(
			{
				"key": key,
				"label": label,
				"kind": "deduction",
				"amount": -amount,
				"subtotal": running,
				"note": note,
				"group": group,
			}
		)

	def tier(key: str, label: str) -> None:
		steps.append(
			{
				"key": key,
				"label": label,
				"kind": "tier",
				"amount": running,
				"subtotal": running,
				"note": None,
				"group": None,
			}
		)

	deduct("cogs", "Cost of goods", row["cogs"], "GL: Cost of Goods Sold + Stock Adjustment accounts")
	deduct("direct", "Direct costs", row["direct"], n_accounts("direct"))
	tier("cm1", "CM1 · Gross margin")
	deduct("freight", "Outbound freight", row["freight"], n_accounts("freight"), "variable")
	deduct("packaging", "Packaging & dispatch", row["packaging"], n_accounts("packaging"), "variable")
	deduct(
		"commission",
		"Transaction fees & commissions",
		row["commission"],
		n_accounts("commission"),
		"variable",
	)
	deduct("scheme", "Trade schemes & rebates", row["scheme"], n_accounts("scheme"), "variable")
	tier("cm2", "CM2 · Before marketing")
	deduct("marketing", "Marketing", row["marketing"], n_accounts("marketing"))
	tier("cm3", "CM3 · After marketing")
	deduct("salary", "Salary & payroll", row["salary"], n_accounts("salary"), "operating")
	deduct("rent", "Rent & lease", row["rent"], n_accounts("rent"), "operating")
	deduct("utility", "Utilities & communications", row["utility"], n_accounts("utility"), "operating")
	deduct("admin", "Admin & general overhead", row["admin"], n_accounts("admin"), "operating")
	deduct(
		"other", "Other expenses less other income", row["other_net"], "unmapped P&L accounts", "operating"
	)
	deduct(
		"internal",
		"Internal transfers (net)",
		row["internal"],
		"branch / inter-company transfer accounts",
		"operating",
	)
	tier("ebitda", "EBITDA")
	deduct("da", "Depreciation & amortization", row["da"], n_accounts("da"))
	tier("ebit", "EBIT")
	deduct("interest", "Interest & finance cost", row["interest"], n_accounts("interest"))
	tier("pbt", "PBT · Profit before tax")
	deduct("tax", "Income tax", row["tax"], n_accounts("tax"))
	tier("pat", "PAT · Profit after tax")
	for s in steps:
		s["pct"] = _pct(s["amount"], row["revenue"])
	_attach_sources(steps, row, pl, bucket, revenue_sources or [])
	return steps


# ── Overview ────────────────────────────────────────────────────────────────


def _revenue_sources(lines: list[SalesLine]) -> dict[str, list[dict]]:
	"""Ex-tax invoice-line revenue by income account, overall and per bucket."""
	agg: dict[str, dict[str, float]] = {b: defaultdict(float) for b in ("overall", *BUCKETS)}
	for ln in lines:
		agg["overall"][ln.income_account] += ln.rev_excl
		agg[ln.bucket][ln.income_account] += ln.rev_excl
	return {
		b: [
			{
				"account": acc or None,
				"label": None if acc else "(no income account)",
				"amount": amt,
				"root_type": "Income",
			}
			for acc, amt in sorted(vals.items(), key=lambda kv: -abs(kv[1]))
			if abs(amt) >= 0.005
		]
		for b, vals in agg.items()
	}


def _monthly_revenue(period: Period, lines: list[SalesLine], mode: str) -> list[dict]:
	"""Per-month revenue in ₹L by bucket. Totals are rounded once, from raw sums."""
	raw: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(BUCKETS, 0.0))
	for ln in lines:
		raw[ln.month][ln.bucket] += ln.rev(mode)
	out = []
	cursor = period.from_date.replace(day=1)
	last_partial = period.to_date.day != calendar.monthrange(period.to_date.year, period.to_date.month)[1]
	while cursor <= period.to_date:
		key = f"{cursor.year}-{cursor.month:02d}"
		vals = raw.get(key, dict.fromkeys(BUCKETS, 0.0))
		is_last = cursor.year == period.to_date.year and cursor.month == period.to_date.month
		out.append(
			{
				"key": key,
				"month": MONTH_ABBR[cursor.month - 1],
				"year": cursor.year,
				"b2c": round(vals["b2c"] / 1_00_000, 2),
				"b2b": round(vals["b2b"] / 1_00_000, 2),
				"other": round(vals["unclassified"] / 1_00_000, 2),
				"total": round(sum(vals.values()) / 1_00_000, 2),
				"partial": bool(is_last and last_partial) or (cursor < period.from_date),
			}
		)
		cursor = getdate(add_months(cursor, 1))
	return out


def _categories(lines: list[SalesLine], mode: str) -> list[dict]:
	"""Top-N item groups by revenue; the rest collapses into 'Other'."""
	agg: dict[str, dict] = {}
	for ln in lines:
		e = agg.setdefault(ln.item_group, {"revenue": 0.0, "skus": set()})
		e["revenue"] += ln.rev(mode)
		e["skus"].add(ln.item_code)
	rows = sorted(agg.items(), key=lambda kv: kv[1]["revenue"], reverse=True)
	out = [
		{"category": k, "sku_count": len(v["skus"]), "revenue": round(v["revenue"] / 1_00_000, 2)}
		for k, v in rows[:TOP_N_CATEGORIES]
	]
	rest = rows[TOP_N_CATEGORIES:]
	if rest:
		out.append(
			{
				"category": "Other",
				"sku_count": len(set().union(*(v["skus"] for _k, v in rest))),
				"revenue": round(sum(v["revenue"] for _k, v in rest) / 1_00_000, 2),
			}
		)
	return out


def _avg_mrp(item_codes: set[str], as_of: date) -> float | None:
	"""Average MRP over items sold in the period, from the MRP price list (latest valid
	price per item). None when no MRP price list exists."""
	price_list = get_mrp_price_list()
	if not price_list or not item_codes:
		return None
	rows = frappe.db.sql(
		"""
		select item_code, price_list_rate
		from `tabItem Price`
		where price_list = %(pl)s and item_code in %(items)s and price_list_rate > 0
		  and (valid_from is null or valid_from <= %(d)s)
		  and (valid_upto is null or valid_upto >= %(d)s)
		order by item_code, valid_from desc
		""",
		{"pl": price_list, "items": tuple(item_codes), "d": as_of},
	)
	latest: dict[str, float] = {}
	for code, rate in rows:
		latest.setdefault(code, flt(rate))
	return (sum(latest.values()) / len(latest)) if latest else None


def _compute_overview(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	company: str | None = None,
) -> dict:
	if not _erpnext_installed():
		frappe.throw(_("ERPNext is not installed on this site."))

	mode = tax_mode if tax_mode in TAX_MODES else "excl"
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	lines = _sales_lines(company, period.from_date, period.to_date)

	rev_disp = dict.fromkeys(BUCKETS, 0.0)
	rev_excl = dict.fromkeys(BUCKETS, 0.0)
	line_cost = dict.fromkeys(BUCKETS, 0.0)
	by_bucket: dict[str, list[SalesLine]] = {b: [] for b in BUCKETS}
	for ln in lines:
		rev_disp[ln.bucket] += ln.rev(mode)
		rev_excl[ln.bucket] += ln.rev_excl
		line_cost[ln.bucket] += ln.allocated_cost
		by_bucket[ln.bucket].append(ln)
	rev_excl["overall"] = sum(rev_excl[b] for b in BUCKETS)
	rev_disp_total = sum(rev_disp.values())

	pl = _pl_breakdown(company, period, rev_excl["overall"])
	ladder = _ladder(rev_excl, line_cost, pl)
	revenue_sources = _revenue_sources(lines)
	prior = _revenue_by_bucket(company, period.prior_from, period.prior_to, mode)
	period_info = _period_dict(period, company)
	quality = _quality(lines)
	quality["warnings"] = pl["warnings"] + _unconfigured_income_warnings(company, period)
	quality["unallocated_cogs"] = ladder["overall"]["cogs_unallocated"]
	quality["pat_residual"] = ladder["overall"]["pat"] - pl["gl_net_profit"]

	kpi: dict = {
		"total_revenue": rev_disp_total,
		"total_revenue_excl": rev_excl["overall"],
		"total_revenue_prior": prior["total"],
		"prior_available": period_info["prior"]["available"],
		"cogs": ladder["overall"]["cogs"],
		"cogs_allocated": ladder["overall"]["cogs_allocated"],
		"cogs_unallocated": ladder["overall"]["cogs_unallocated"],
		"direct_costs": ladder["overall"]["direct"],
		"other_expenses": ladder["overall"]["other_expense"],
		"other_income": ladder["overall"]["other_income"],
		"internal_transfers": ladder["overall"]["internal"],
		"gl_net_profit": pl["gl_net_profit"],
		"pat_residual": quality["pat_residual"],
		"cm2_deduction": ladder["overall"]["variable"],
		"cm3_deduction": ladder["overall"]["marketing"],
	}
	for b, prefix in (("overall", ""), ("b2c", "b2c_"), ("b2b", "b2b_"), ("unclassified", "unclassified_")):
		row = ladder[b]
		if b != "overall":
			kpi[f"{b}_revenue"] = rev_disp[b]
			kpi[f"{b}_revenue_excl"] = rev_excl[b]
			kpi[f"{b}_revenue_prior"] = prior[b]
			kpi[f"{b}_gross_margin_coverage_pct"] = _coverage(by_bucket[b])
		else:
			kpi["gross_margin_coverage_pct"] = quality["coverage_pct"]
		kpi[f"{prefix}gross_profit"] = row["cm1"]
		kpi[f"{prefix}gross_margin_pct"] = row["cm1_pct"]
		for tier in ("cm1", "cm2", "cm3", "ebitda", "ebit", "pbt", "pat"):
			kpi[f"{prefix}{tier}"] = row[tier]
			kpi[f"{prefix}{tier}_pct"] = row[f"{tier}_pct"]

	sold_items = {ln.item_code for ln in lines}
	kpi["active_skus"] = len({ln.item_code for ln in lines if ln.is_stock_item and ln.rev_excl > 0})
	kpi["avg_mrp"] = _avg_mrp(sold_items, period.to_date)

	o = ladder["overall"]
	acc = pl["accounts"]
	return {
		"period": period_info,
		"company": company,
		"tax_mode": mode,
		"basis": {"revenue": mode, "margins": "excl"},
		"kpi": kpi,
		"pnl": {b: _pnl_steps(ladder[b], pl, b, revenue_sources[b]) for b in ("overall", *BUCKETS)},
		"cm2_inputs": {
			"freight_total": o["freight"],
			"packaging_total": o["packaging"],
			"commission_total": o["commission"],
			"scheme_total": o["scheme"],
			"variable_total": o["variable"],
			"freight_accounts": acc["freight"],
			"packaging_accounts": acc["packaging"],
			"commission_accounts": acc["commission"],
			"scheme_accounts": acc["scheme"],
			"allocation_basis": "tax-excl revenue share",
			"company_scope": company,
		},
		"cm3_inputs": {
			"marketing_total": o["marketing"],
			"marketing_accounts": acc["marketing"],
			"allocation_basis": "tax-excl revenue share",
			"company_scope": company,
		},
		"ladder_inputs": {
			"cogs_total": o["cogs"],
			"cogs_allocated": o["cogs_allocated"],
			"cogs_unallocated": o["cogs_unallocated"],
			"cogs_accounts": pl["cogs_accounts"],
			"direct_total": o["direct"],
			"direct_accounts": acc["direct"],
			"salary_total": o["salary"],
			"rent_total": o["rent"],
			"utility_total": o["utility"],
			"admin_total": o["admin"],
			"operating_total": o["operating"],
			"other_expense_total": o["other_expense"],
			"other_income_total": o["other_income"],
			"other_net_total": o["other_net"],
			"internal_total": o["internal"],
			"internal_accounts": pl["internal_accounts"],
			"unmapped_expense_accounts": pl["unmapped_expense_accounts"],
			"other_income_accounts": pl["other_income_accounts"],
			"revenue_gl_difference": pl["revenue_gl_difference"],
			"sales_gl": pl["sales_gl"],
			"da_total": o["da"],
			"interest_total": o["interest"],
			"tax_total": o["tax"],
			"salary_accounts": acc["salary"],
			"rent_accounts": acc["rent"],
			"utility_accounts": acc["utility"],
			"admin_accounts": acc["admin"],
			"da_accounts": acc["da"],
			"interest_accounts": acc["interest"],
			"tax_accounts": acc["tax"],
			"gl_net_profit": pl["gl_net_profit"],
			"allocation_basis": "tax-excl revenue share",
			"company_scope": company,
		},
		"monthly": _monthly_revenue(period, lines, mode),
		"categories": _categories(lines, mode),
		"data_quality": quality,
		"settings": {
			"outbound_freight_accounts": acc["freight"],
			"packaging_overhead_accounts": acc["packaging"],
		},
		"debug": {
			"classification": "Item.custom_sales_intent (B2C*/B2B*)",
			"intent_field_present": _intent_col() != "null",
			"tax_mode": mode,
			"excluded_internal": _excluded_customer_stats(company, period, mode),
			"generated_at": datetime.now(timezone.utc).isoformat(),
		},
	}


# ── SKU assortment ──────────────────────────────────────────────────────────


def _intent_filter(lines: list[SalesLine], intent: str) -> list[SalesLine]:
	if intent in ("b2c", "b2b"):
		return [ln for ln in lines if ln.bucket == intent]
	return lines


def _compute_sku_assortment(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
	company: str | None = None,
) -> dict:
	if not _erpnext_installed():
		frappe.throw(_("ERPNext is not installed on this site."))

	mode = tax_mode if tax_mode in TAX_MODES else "excl"
	intent = intent if intent in ("all", "b2c", "b2b") else "all"
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	all_lines = _sales_lines(company, period.from_date, period.to_date)
	lines = _intent_filter(all_lines, intent)

	month_keys: list[str] = []
	cursor = period.from_date.replace(day=1)
	while cursor <= period.to_date:
		month_keys.append(f"{cursor.year}-{cursor.month:02d}")
		cursor = getdate(add_months(cursor, 1))

	skus: dict[str, dict] = {}
	for ln in lines:
		s = skus.get(ln.item_code)
		if s is None:
			s = skus[ln.item_code] = {
				"item_code": ln.item_code,
				"item_name": ln.item_name,
				"item_group": ln.item_group,
				"intent": ln.intent or "—",
				"is_stock_item": ln.is_stock_item,
				"stock_uom": ln.stock_uom,
				"revenue": 0.0,
				"revenue_excl": 0.0,
				"sold_revenue_excl": 0.0,
				"valued_revenue_excl": 0.0,
				"cogs": 0.0,
				"flagged_lines": 0,
				"flagged_cost": 0.0,
				"qty": 0.0,
				"_invoices": set(),
				"monthly": dict.fromkeys(month_keys, 0.0),
			}
		s["revenue"] += ln.rev(mode)
		s["revenue_excl"] += ln.rev_excl
		s["cogs"] += ln.allocated_cost
		if ln.rev_excl > 0:
			s["sold_revenue_excl"] += ln.rev_excl
			if ln.valued:
				s["valued_revenue_excl"] += ln.rev_excl
		if ln.flagged:
			s["flagged_lines"] += 1
			s["flagged_cost"] += ln.cost or 0.0
		s["qty"] += ln.stock_qty
		s["_invoices"].add(ln.invoice)
		if ln.month in s["monthly"]:
			s["monthly"][ln.month] += ln.rev(mode)

	# Allocation rates: GL cost ÷ company tax-exclusive revenue (all intents), applied to
	# each SKU's tax-exclusive revenue — never to tax-inclusive revenue.
	company_rev_excl = sum(ln.rev_excl for ln in all_lines)
	pl = _pl_breakdown(company, period, company_rev_excl)
	t = pl["totals"]

	def rate(x: float) -> float:
		return (x / company_rev_excl) if company_rev_excl else 0.0

	rates = {k: rate(t[k]) for k in (*VARIABLE_KEYS, "marketing", "direct")}
	variable_rate = sum(rates[k] for k in VARIABLE_KEYS)

	out_rows: list[dict] = []
	for s in skus.values():
		rev = s["revenue_excl"]
		s["invoices"] = len(s.pop("_invoices"))
		alloc = {k: rev * rates[k] for k in (*VARIABLE_KEYS, "marketing")}
		gp = rev - s["cogs"]
		cm2 = gp - rev * variable_rate
		cm3 = cm2 - alloc["marketing"]
		out_rows.append(
			{
				**s,
				"gp": gp,
				"gm_pct": _pct(gp, rev),
				"cost_coverage_pct": _pct(s["valued_revenue_excl"], s["sold_revenue_excl"]),
				"alloc_freight": alloc["freight"],
				"alloc_packaging": alloc["packaging"],
				"alloc_commission": alloc["commission"],
				"alloc_scheme": alloc["scheme"],
				"alloc_marketing": alloc["marketing"],
				"alloc_variable": rev * variable_rate,
				"cm2": cm2,
				"cm2_pct": _pct(cm2, rev),
				"cm3": cm3,
				"cm3_pct": _pct(cm3, rev),
			}
		)
	out_rows.sort(key=lambda r: r["revenue"], reverse=True)

	# The GL cost of goods not tied to any line (stock adjustments, JV/PI/PR/SE cost,
	# flagged lines) plus direct costs. With an intent filter, its revenue share.
	scope_rev = sum(r["revenue_excl"] for r in out_rows)
	scope_share = (scope_rev / company_rev_excl) if company_rev_excl else (1.0 if intent == "all" else 0.0)
	unallocated = (pl["cogs"] - sum(ln.allocated_cost for ln in all_lines)) * scope_share
	direct = t["direct"] * scope_share
	cogs_rows = sum(r["cogs"] for r in out_rows)
	gp_total = scope_rev - cogs_rows - unallocated - direct

	qty_by_uom: dict[str, float] = defaultdict(float)
	for r in out_rows:
		qty_by_uom[r["stock_uom"] or "—"] += r["qty"]

	quality = _quality(lines)
	quality["warnings"] = pl["warnings"]
	return {
		"period": _period_dict(period, company),
		"company": company,
		"tax_mode": mode,
		"basis": {"revenue": mode, "margins": "excl"},
		"intent": intent,
		"month_keys": month_keys,
		"rows": out_rows,
		"totals": {
			"sku_count": len(out_rows),
			"revenue": sum(r["revenue"] for r in out_rows),
			"revenue_excl": scope_rev,
			"cogs": cogs_rows,
			"cogs_unallocated": unallocated,
			"direct_costs": direct,
			"gp": gp_total,
			"gm_pct": _pct(gp_total, scope_rev),
			"qty_by_uom": dict(qty_by_uom),
			"flagged_lines": quality["flagged_lines"],
			"flagged_cost": quality["flagged_cost"],
		},
		"allocation": {
			"basis": "GL cost ÷ company tax-exclusive revenue, applied to each SKU's tax-exclusive revenue",
			"freight_pct": rates["freight"] * 100,
			"packaging_pct": rates["packaging"] * 100,
			"commission_pct": rates["commission"] * 100,
			"scheme_pct": rates["scheme"] * 100,
			"marketing_pct": rates["marketing"] * 100,
			"variable_pct": variable_rate * 100,
		},
		"data_quality": quality,
	}


# ── Customer segments ──────────────────────────────────────────────────────


def _segment_prior(
	company: str, period: Period, mode: str, intent: str, remap, allowed: set[str] | None
) -> dict[str, float]:
	"""Prior-window revenue per (rolled-up) segment, same filters as the current window."""
	params: dict = {}
	amt = AMT_INCL if mode == "incl" else AMT_EXCL
	rows = frappe.db.sql(
		f"""
		select {_segment_sql()} as segment, {_intent_bucket_sql()}, coalesce(sum({amt}), 0) as revenue
		from {SII_BASE_FROM}
		where {_base_where(params, company, period.prior_from, period.prior_to)}
		group by segment, bucket
		""",
		params,
		as_dict=True,
	)
	out: dict[str, float] = defaultdict(float)
	for r in rows:
		if intent in ("b2c", "b2b") and r["bucket"] != intent:
			continue
		if allowed is not None and r["segment"] not in allowed:
			continue
		out[remap(r["segment"])] += flt(r["revenue"])
	return out


def _compute_customer_segments(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
	top_n_customers: int = 10,
	top_n_categories: int = 10,
	company: str | None = None,
) -> dict:
	if not _erpnext_installed():
		frappe.throw(_("ERPNext is not installed on this site."))

	mode = tax_mode if tax_mode in TAX_MODES else "excl"
	intent = intent if intent in ("all", "b2c", "b2b") else "all"
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	period_info = _period_dict(period, company)
	top_n_customers = max(int(top_n_customers or 10), 1)
	top_n_categories = max(int(top_n_categories or 10), 1)

	# Customer Group scope from settings: empty → every group (plus "(unassigned)").
	# Otherwise only those groups and their descendants, rolled up into the selected root.
	scope_map = get_segment_root_map()
	allowed = set(scope_map) if scope_map else None

	def remap(seg: str) -> str:
		return scope_map.get(seg, seg) if scope_map else seg

	all_lines = _sales_lines(company, period.from_date, period.to_date)
	lines = [ln for ln in _intent_filter(all_lines, intent) if allowed is None or ln.segment in allowed]

	month_keys: list[str] = []
	cursor = period.from_date.replace(day=1)
	while cursor <= period.to_date:
		month_keys.append(f"{cursor.year}-{cursor.month:02d}")
		cursor = getdate(add_months(cursor, 1))

	segs: dict[str, dict] = {}
	for ln in lines:
		seg = remap(ln.segment)
		s = segs.get(seg)
		if s is None:
			s = segs[seg] = {
				"segment": seg,
				"revenue": 0.0,
				"revenue_excl": 0.0,
				"_lines": [],
				"cogs": 0.0,
				"_customers": {},
				"_invoices": set(),
				"_monthly": dict.fromkeys(month_keys, 0.0),
				"_cats": {},
			}
		r = ln.rev(mode)
		s["revenue"] += r
		s["revenue_excl"] += ln.rev_excl
		s["cogs"] += ln.allocated_cost
		s["_lines"].append(ln)
		s["_invoices"].add(ln.invoice)
		cust = s["_customers"].setdefault(
			ln.customer,
			{"customer": ln.customer, "customer_name": ln.customer_name, "revenue": 0.0, "_inv": set()},
		)
		cust["revenue"] += r
		cust["_inv"].add(ln.invoice)
		if ln.month in s["_monthly"]:
			s["_monthly"][ln.month] += r
		cat = s["_cats"].setdefault(
			ln.item_group, {"category": ln.item_group, "revenue": 0.0, "_skus": set()}
		)
		cat["revenue"] += r
		cat["_skus"].add(ln.item_code)

	prior = _segment_prior(company, period, mode, intent, remap, allowed)
	prior_ok = period_info["prior"]["available"]

	segments: list[dict] = []
	for seg, s in segs.items():
		rev, rev_excl = s["revenue"], s["revenue_excl"]
		invoices, customers = len(s["_invoices"]), len(s["_customers"])
		gp = rev_excl - s["cogs"]
		prev = prior.get(seg, 0.0)
		ranked_customers = sorted(s["_customers"].values(), key=lambda c: c["revenue"], reverse=True)
		ranked_cats = sorted(s["_cats"].values(), key=lambda c: c["revenue"], reverse=True)
		segments.append(
			{
				"segment": seg,
				"revenue": rev,
				"revenue_excl": rev_excl,
				"prior_revenue": prev,
				"yoy_pct": ((rev - prev) / abs(prev) * 100) if (prior_ok and prev) else None,
				"customers": customers,
				"invoices": invoices,
				"aov": (rev / invoices) if invoices else None,
				"avg_customer_value": (rev / customers) if customers else None,
				"cogs": s["cogs"],
				"gp": gp,
				"gm_pct": _pct(gp, rev_excl),
				"gm_coverage_pct": _coverage(s["_lines"]),
				"monthly": {k: round(v / 1_00_000, 2) for k, v in s["_monthly"].items()},
				"top_customers": [
					{
						"customer": c["customer"],
						"customer_name": c["customer_name"],
						"revenue": c["revenue"],
						"invoices": len(c["_inv"]),
					}
					for c in ranked_customers[:top_n_customers]
				],
				"top_categories": [
					{"category": c["category"], "sku_count": len(c["_skus"]), "revenue": c["revenue"]}
					for c in ranked_cats[:top_n_categories]
				],
			}
		)
	segments.sort(key=lambda s: s["revenue"], reverse=True)

	total_rev_excl = sum(s["revenue_excl"] for s in segments)
	company_rev_excl = sum(ln.rev_excl for ln in all_lines)
	pl = _pl_breakdown(company, period, company_rev_excl)
	scope_share = (total_rev_excl / company_rev_excl) if company_rev_excl else 0.0
	unallocated = (pl["cogs"] - sum(ln.allocated_cost for ln in all_lines)) * scope_share
	gp_lines = sum(s["gp"] for s in segments)
	invoices_total = len({ln.invoice for ln in lines})
	revenue_total = sum(s["revenue"] for s in segments)
	totals = {
		"revenue": revenue_total,
		"revenue_excl": total_rev_excl,
		"prior_revenue": sum(prior.values()),
		"customers": len({ln.customer for ln in lines}),
		"invoices": invoices_total,
		"gp": gp_lines,
		"gm_pct": _pct(gp_lines, total_rev_excl),
		"cogs_unallocated": unallocated,
		"gp_after_unallocated": gp_lines - unallocated - pl["totals"]["direct"] * scope_share,
		"segment_count": len(segments),
		"aov": (revenue_total / invoices_total) if invoices_total else None,
	}
	totals["gm_pct_after_unallocated"] = _pct(totals["gp_after_unallocated"], total_rev_excl)

	quality = _quality(lines)
	quality["warnings"] = pl["warnings"]
	return {
		"period": period_info,
		"company": company,
		"tax_mode": mode,
		"basis": {"revenue": mode, "margins": "excl"},
		"intent": intent,
		"scope_roots": sorted(set(scope_map.values())),
		"is_scoped": bool(scope_map) or intent != "all",
		"month_keys": month_keys,
		"segments": segments,
		"totals": totals,
		"data_quality": quality,
	}


# ── Users and fiscal years ─────────────────────────────────────────────────


@frappe.whitelist()
def create_dashboard_user(
	email: str,
	first_name: str,
	last_name: str = "",
	password: str | None = None,
	send_welcome_email: bool = False,
	mis: bool = True,
	wc: bool = False,
) -> dict:
	"""Provision a dashboard-only user with MIS and/or WC Viewer roles.

	Restricted to System Managers. Only the two viewer roles are added or removed —
	every other role the user has is left alone. Administrators and System Managers
	can't be changed here, and a password is only set on users that have no other roles.
	"""
	if frappe.session.user != "Administrator" and "System Manager" not in frappe.get_roles(
		frappe.session.user
	):
		frappe.throw(_("Only a System Manager can create dashboard users."), frappe.PermissionError)

	from frappe.utils import validate_email_address

	from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
		MIS_VIEWER_ROLE,
		WC_VIEWER_ROLE,
		ensure_mis_viewer_role,
		ensure_wc_viewer_role,
	)

	email = (email or "").strip()
	validate_email_address(email, throw=True)
	mis, wc, send_welcome_email = sbool(mis), sbool(wc), sbool(send_welcome_email)
	ensure_mis_viewer_role()
	ensure_wc_viewer_role()

	viewer_roles = {MIS_VIEWER_ROLE, WC_VIEWER_ROLE}
	automatic = set(
		getattr(frappe.permissions, "AUTOMATIC_ROLES", ("Administrator", "Guest", "All", "Desk User"))
	)
	existing = frappe.db.exists("User", email)
	if existing:
		user = frappe.get_doc("User", existing)
		current = {r.role for r in user.roles}
		if user.name in ("Administrator", "Guest") or "System Manager" in current:
			frappe.throw(
				_("{0} is an administrator. Change their roles from the User form, not here.").format(
					user.name
				),
				frappe.PermissionError,
			)
		other_roles = current - viewer_roles - automatic
		if password and other_roles:
			frappe.throw(
				_("{0} has other roles ({1}). Their password can only be changed from the User form.").format(
					user.name, ", ".join(sorted(other_roles))
				),
				frappe.PermissionError,
			)
	else:
		user = frappe.new_doc("User")
		user.email = email
		user.first_name = first_name
		user.last_name = last_name
		user.user_type = "System User"
		user.send_welcome_email = 1 if send_welcome_email else 0
		current = set()

	wanted = {MIS_VIEWER_ROLE: mis, WC_VIEWER_ROLE: wc}
	for role, on in wanted.items():
		if on and role not in current:
			user.append("roles", {"role": role})
	user.set("roles", [r for r in user.roles if wanted.get(r.role, True)])

	if password:
		user.new_password = password

	user.flags.ignore_permissions = True
	if existing:
		user.save()
	else:
		user.insert()

	return {
		"email": user.email,
		"created": not existing,
		"updated": bool(existing),
		"roles": [r.role for r in user.roles],
		"login_url": "/login",
		"dashboard_url": "/bizdashboard",
	}


# Backward compat alias
create_mis_user = create_dashboard_user


@frappe.whitelist()
def get_fiscal_years(company: str | None = None) -> list[dict]:
	"""Non-disabled Fiscal Years that apply to the company, newest first."""
	_require_mis_access()
	company = _resolve_company(company)
	rows = frappe.get_all(
		"Fiscal Year",
		filters={"disabled": 0},
		fields=["name", "year_start_date", "year_end_date"],
		order_by="year_start_date desc",
	)
	links: dict[str, set[str]] = defaultdict(set)
	for parent, comp in frappe.db.sql(
		"select parent, company from `tabFiscal Year Company` where parenttype = 'Fiscal Year'"
	):
		links[parent].add(comp)
	return [
		{
			"name": r["name"],
			"from": r["year_start_date"].isoformat() if r["year_start_date"] else None,
			"to": r["year_end_date"].isoformat() if r["year_end_date"] else None,
		}
		for r in rows
		if not links.get(r["name"]) or company in links[r["name"]]
	]


# ── Whitelisted, cached endpoints ──────────────────────────────────────────


@frappe.whitelist()
def get_overview(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	company: str | None = None,
) -> dict:
	"""Overview KPIs + P&L ladder + monthly trend + category mix (24-hour cache)."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	params = {
		"company": company,
		"tax_mode": tax_mode,
		"from_date": from_date,
		"to_date": to_date,
		**_ttm_cache_anchor(from_date, to_date),
	}
	kwargs = {"tax_mode": tax_mode, "from_date": from_date, "to_date": to_date, "company": company}
	return _cached(
		"mis",
		"overview",
		lambda: _compute_overview(**kwargs),
		params,
		job=("company_dashboard.api.mis._compute_overview", kwargs),
	)


@frappe.whitelist()
def get_sku_assortment(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
	company: str | None = None,
) -> dict:
	"""Per-SKU revenue, stock-ledger cost, monthly trend and CM allocation (24-hour cache)."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	params = {
		"company": company,
		"tax_mode": tax_mode,
		"from_date": from_date,
		"to_date": to_date,
		"intent": intent,
		**_ttm_cache_anchor(from_date, to_date),
	}
	kwargs = {
		"tax_mode": tax_mode,
		"from_date": from_date,
		"to_date": to_date,
		"intent": intent,
		"company": company,
	}
	return _cached(
		"mis",
		"sku_assortment",
		lambda: _compute_sku_assortment(**kwargs),
		params,
		job=("company_dashboard.api.mis._compute_sku_assortment", kwargs),
	)


@frappe.whitelist()
def get_customer_segments(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
	top_n_customers: int = 10,
	top_n_categories: int = 10,
	company: str | None = None,
) -> dict:
	"""Per-Customer-Group analysis (24-hour cache)."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	# top_n_* change the sliced row counts, so they must be in the cache key.
	params = {
		"company": company,
		"tax_mode": tax_mode,
		"from_date": from_date,
		"to_date": to_date,
		"intent": intent,
		"top_n_customers": top_n_customers,
		"top_n_categories": top_n_categories,
		**_ttm_cache_anchor(from_date, to_date),
	}
	kwargs = {
		"tax_mode": tax_mode,
		"from_date": from_date,
		"to_date": to_date,
		"intent": intent,
		"top_n_customers": top_n_customers,
		"top_n_categories": top_n_categories,
		"company": company,
	}
	return _cached(
		"mis",
		"customer_segments",
		lambda: _compute_customer_segments(**kwargs),
		params,
		job=("company_dashboard.api.mis._compute_customer_segments", kwargs),
	)


@frappe.whitelist()
def get_ui_flags() -> dict:
	"""Fresh 'Coming soon' tile flags and section access, so a settings change applies on the
	next page load without waiting for the cached boot payload."""
	_require_dashboard_access()
	from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
		get_coming_soon_tiles,
	)

	user = frappe.session.user
	roles = set(frappe.get_roles(user))
	is_admin = user == "Administrator"
	return {
		"coming_soon_tiles": get_coming_soon_tiles(),
		"sections": {
			"mis": is_admin or bool(roles & MIS_ACCESS_ROLES),
			"wc": is_admin or bool(roles & WC_ACCESS_ROLES),
		},
	}
