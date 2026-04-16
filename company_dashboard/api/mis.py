"""MIS dashboard API — real ERPNext metrics.

Classification rules (this file is the single source of truth — keep it in sync with
the UI labels and the P2/P3 APIs when they land):

- **B2C vs B2B** is decided by ``Item.custom_sales_intent`` (values ``B2C Retail``,
  ``B2C Wholesale``, ``B2B Raw``, ``B2B Processed``). We match on the ``B2C`` / ``B2B``
  prefix so new values that follow the convention keep working.
- **Internal transfers are excluded** — any invoice whose customer has
  ``is_internal_customer`` or ``is_bns_internal_customer`` set is dropped from every
  revenue aggregation. This keeps inter-company stock movement from inflating MIS.
- Revenue amounts are ``base_net_amount`` at line level (tax-exclusive, in company
  currency) so mix and total reconcile exactly.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import frappe
from frappe import _
from frappe.utils import add_months, flt, getdate, today

from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
	get_configured_accounts,
)

MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

TOP_N_CATEGORIES = 10

# Reusable join+filter — every revenue query must use these to stay consistent.
# Parameters expected in the containing query: %(from)s, %(to)s.
SII_BASE_FROM = """
	`tabSales Invoice Item` sii
	join `tabSales Invoice`   si on si.name = sii.parent
	left join `tabItem`       i  on i.name  = sii.item_code
	left join `tabCustomer`   c  on c.name  = si.customer
"""
SII_BASE_WHERE = """
	si.docstatus = 1
	and si.is_return = 0
	and si.posting_date between %(from)s and %(to)s
	and coalesce(c.is_internal_customer, 0) = 0
	and coalesce(c.is_bns_internal_customer, 0) = 0
"""

# Line amount expressions. Tax-inclusive pro-rates the invoice's grand-total back to
# each line by its share of net_total, so totals reconcile to base_grand_total exactly
# even with invoice-level discounts.
AMT_EXCL = "sii.base_net_amount"
AMT_INCL = (
	"sii.base_net_amount * case when si.base_net_total > 0 "
	"then si.base_grand_total / si.base_net_total else 1 end"
)
TAX_MODES = {"incl": AMT_INCL, "excl": AMT_EXCL}


def has_mis_permission():
	"""Used by ``add_to_apps_screen`` to decide if the tile shows."""
	user = frappe.session.user
	if user == "Administrator":
		return True
	roles = set(frappe.get_roles(user))
	return bool(roles.intersection({"System Manager", "MIS Viewer", "Accounts Manager"}))


def _require_login():
	if frappe.session.user == "Guest":
		frappe.throw(_("Login required."), frappe.PermissionError)


def _erpnext_installed() -> bool:
	return "erpnext" in frappe.get_installed_apps()


@dataclass
class Period:
	from_date: date
	to_date: date
	prior_from: date
	prior_to: date
	label: str

	def as_dict(self) -> dict:
		return {
			"from": self.from_date.isoformat(),
			"to": self.to_date.isoformat(),
			"label": self.label,
		}


def _ttm_window(anchor: date | None = None) -> Period:
	"""Trailing 12 months ending on the last day of the current month."""
	ref = anchor or getdate(today())
	last_day = calendar.monthrange(ref.year, ref.month)[1]
	to_date = ref.replace(day=last_day)
	from_date = getdate(add_months(to_date.replace(day=1), -11))
	return _build_period(from_date, to_date, label_prefix="Trailing 12 months")


def _custom_window(from_date: date, to_date: date) -> Period:
	"""User-selected range. Prior period is the immediately-preceding same-length window."""
	if to_date < from_date:
		from_date, to_date = to_date, from_date
	return _build_period(from_date, to_date, label_prefix="Custom")


def _build_period(from_date: date, to_date: date, label_prefix: str) -> Period:
	"""Construct a Period with its prior-period window computed as the same-length
	immediately-preceding window (so YoY/prior deltas stay apples-to-apples on ranges
	that aren't exactly 12 months)."""
	span_days = (to_date - from_date).days
	prior_to = getdate(from_date) - timedelta(days=1)
	prior_from = prior_to - timedelta(days=span_days)
	label = (
		f"{label_prefix} · {from_date.strftime('%b %Y')} – {to_date.strftime('%b %Y')}"
		if label_prefix
		else f"{from_date.isoformat()} – {to_date.isoformat()}"
	)
	return Period(from_date, to_date, prior_from, prior_to, label)


def _intent_bucket_expr(alias: str = "bucket") -> str:
	"""SQL CASE that collapses ``custom_sales_intent`` into (b2c, b2b, unclassified)."""
	return f"""
		case
			when i.custom_sales_intent like 'B2C%%' then 'b2c'
			when i.custom_sales_intent like 'B2B%%' then 'b2b'
			else 'unclassified'
		end as {alias}
	"""


def _revenue_by_bucket(from_date: date, to_date: date, amt_expr: str) -> dict[str, float]:
	"""Sum per-line amount by (b2c | b2b | unclassified) bucket."""
	rows = frappe.db.sql(
		f"""
		select
			{_intent_bucket_expr()},
			coalesce(sum({amt_expr}), 0) as amt
		from {SII_BASE_FROM}
		where {SII_BASE_WHERE}
		group by bucket
		""",
		{"from": from_date, "to": to_date},
		as_dict=True,
	)
	out = {"b2c": 0.0, "b2b": 0.0, "unclassified": 0.0}
	for row in rows:
		out[row["bucket"]] = flt(row["amt"])
	out["total"] = out["b2c"] + out["b2b"] + out["unclassified"]
	return out


def _monthly_revenue(period: Period, amt_expr: str) -> list[dict]:
	"""Per-month line-level totals in ₹L, split by custom_sales_intent bucket."""
	rows = frappe.db.sql(
		f"""
		select
			year(si.posting_date)                 as yr,
			month(si.posting_date)                as mo,
			{_intent_bucket_expr()},
			coalesce(sum({amt_expr}), 0) as amt
		from {SII_BASE_FROM}
		where {SII_BASE_WHERE}
		group by yr, mo, bucket
		""",
		{"from": period.from_date, "to": period.to_date},
		as_dict=True,
	)
	buckets: dict[tuple[int, int], dict] = {}
	cursor = period.from_date.replace(day=1)
	while cursor <= period.to_date:
		buckets[(cursor.year, cursor.month)] = {
			"month": MONTH_ABBR[cursor.month - 1],
			"year": cursor.year,
			"b2c": 0.0,
			"b2b": 0.0,
			"other": 0.0,
			"total": 0.0,
		}
		cursor = getdate(add_months(cursor, 1))

	for row in rows:
		key = (int(row["yr"]), int(row["mo"]))
		if key not in buckets:
			continue
		amt_lakhs = round(flt(row["amt"]) / 1_00_000, 2)
		bucket = buckets[key]
		bucket["total"] = round(bucket["total"] + amt_lakhs, 2)
		if row["bucket"] == "b2c":
			bucket["b2c"] = amt_lakhs
		elif row["bucket"] == "b2b":
			bucket["b2b"] = amt_lakhs
		else:
			bucket["other"] = amt_lakhs

	return [buckets[k] for k in sorted(buckets.keys())]


def _categories_from_item_group(period: Period, amt_expr: str) -> list[dict]:
	"""Top-N categories by revenue (Item.item_group). Rest collapses into 'Other'."""
	rows = frappe.db.sql(
		f"""
		select
			coalesce(i.item_group, 'Unclassified') as category,
			count(distinct sii.item_code)          as sku_count,
			coalesce(sum({amt_expr}), 0)           as revenue
		from {SII_BASE_FROM}
		where {SII_BASE_WHERE}
		group by category
		order by revenue desc
		""",
		{"from": period.from_date, "to": period.to_date},
		as_dict=True,
	)
	top = rows[:TOP_N_CATEGORIES]
	rest = rows[TOP_N_CATEGORIES:]
	out = [
		{
			"category": r["category"],
			"sku_count": int(r["sku_count"]),
			"revenue": round(flt(r["revenue"]) / 1_00_000, 2),
		}
		for r in top
	]
	if rest:
		out.append(
			{
				"category": "Other",
				"sku_count": sum(int(r["sku_count"]) for r in rest),
				"revenue": round(sum(flt(r["revenue"]) for r in rest) / 1_00_000, 2),
			}
		)
	return out


def _active_sku_stats(period: Period) -> tuple[int, float]:
	"""(active_skus, avg_mrp)."""
	active = frappe.db.sql(
		f"""
		select count(distinct sii.item_code)
		from {SII_BASE_FROM}
		where {SII_BASE_WHERE}
		""",
		{"from": period.from_date, "to": period.to_date},
	)
	active_count = int(active[0][0]) if active and active[0][0] is not None else 0
	avg_mrp = frappe.db.sql(
		"select coalesce(avg(standard_rate), 0) from `tabItem` where disabled = 0 and standard_rate > 0"
	)
	return active_count, flt(avg_mrp[0][0]) if avg_mrp else 0.0


def _gross_margin(period: Period, amt_expr: str) -> dict:
	"""Gross-profit per bucket (overall + b2c + b2b) restricted to valuated lines.

	**Effective cost per line** is ``coalesce(nullif(sii.incoming_rate, 0), dni.incoming_rate, 0)``:
	when a Sales Invoice is drawn from a Delivery Note the stock movement — and hence
	the valuation — lives on the DN. ERPNext usually copies ``incoming_rate`` to the
	SI line, but it's zero in a non-trivial number of rows (on this dataset: ~10% of
	DN-linked lines), so we fall back to the linked ``Delivery Note Item`` to recover
	the cost. Lines where both are zero (service items, un-valuated stock) are treated
	as "unknown cost" — we exclude their revenue from the denominator rather than
	pretending they have 100% margin, and report the coverage ratio so the UI can
	flag low-confidence margins.

	Margin is always computed on ``AMT_EXCL`` (net of GST) regardless of the display
	tax mode — see caller in ``get_overview``.
	"""
	cost_expr = "coalesce(nullif(sii.incoming_rate, 0), dni.incoming_rate, 0)"
	rows = frappe.db.sql(
		f"""
		select
			{_intent_bucket_expr()},
			coalesce(sum({amt_expr}), 0)                                              as rev_total,
			coalesce(sum(case when {cost_expr} > 0 then {amt_expr} else 0 end), 0)    as rev_valuated,
			coalesce(sum({cost_expr} * sii.stock_qty), 0)                             as cogs
		from {SII_BASE_FROM}
		left join `tabDelivery Note Item` dni on dni.name = sii.dn_detail
		where {SII_BASE_WHERE}
		group by bucket
		""",
		{"from": period.from_date, "to": period.to_date},
		as_dict=True,
	)

	def _pack(rev_total: float, rev_val: float, cogs: float) -> dict:
		gp = rev_val - cogs
		pct = (gp / rev_val * 100) if rev_val else 0.0
		coverage = (rev_val / rev_total * 100) if rev_total else 0.0
		return {
			"gross_profit": gp,
			"gross_margin_pct": pct,
			"coverage_pct": coverage,
			"rev_valuated": rev_val,
		}

	bucketed = {b: _pack(0, 0, 0) for b in ("b2c", "b2b", "unclassified")}
	tot_rev = tot_val = tot_cogs = 0.0
	for row in rows:
		b = row["bucket"]
		r_total = flt(row["rev_total"])
		r_val = flt(row["rev_valuated"])
		c = flt(row["cogs"])
		tot_rev += r_total
		tot_val += r_val
		tot_cogs += c
		if b in bucketed:
			bucketed[b] = _pack(r_total, r_val, c)

	overall = _pack(tot_rev, tot_val, tot_cogs)
	return {
		"gross_profit": overall["gross_profit"],
		"gross_margin_pct": overall["gross_margin_pct"],
		"coverage_pct": overall["coverage_pct"],
		"rev_valuated": overall["rev_valuated"],
		"b2c": bucketed["b2c"],
		"b2b": bucketed["b2b"],
	}


def _gl_spend(accounts: list[str], from_date: date, to_date: date, company: str | None) -> float:
	"""Net GL spend (debit − credit) against a set of expense accounts in the window.

	Using ``debit - credit`` so credit notes / reversal journals reduce the amount
	instead of inflating it. Expense accounts have natural debit balances so this
	returns a positive number when money went out.
	"""
	if not accounts:
		return 0.0
	params: dict[str, object] = {
		"accounts": tuple(accounts),
		"from": from_date,
		"to": to_date,
	}
	company_clause = ""
	if company:
		company_clause = "and ge.company = %(company)s"
		params["company"] = company
	rows = frappe.db.sql(
		f"""
		select coalesce(sum(ge.debit - ge.credit), 0) as amt
		from `tabGL Entry` ge
		where ge.account in %(accounts)s
		  and ge.posting_date between %(from)s and %(to)s
		  and coalesce(ge.is_cancelled, 0) = 0
		  {company_clause}
		""",
		params,
		as_dict=True,
	)
	return flt(rows[0]["amt"]) if rows else 0.0


def _ebitda_ebit_pat(
	period: Period,
	company: str,
	rev_buckets_excl: dict[str, float],
	cm3_overall: float,
	cm3_b2c: float,
	cm3_b2b: float,
) -> dict:
	"""Below-CM3 P&L ladder: EBITDA → EBIT → PBT → PAT.

	::
	   EBITDA = CM3   − Salary − Rent − Utilities − Admin           (fixed operating)
	   EBIT   = EBITDA − Depreciation & Amortization                (capex absorption)
	   PBT    = EBIT   − Interest & Finance Cost                    (below-the-line)
	   PAT    = PBT    − Income Tax Expense                         (profit after tax)

	All four deductions come from GL Entry against admin-configured account multiselects.
	GL has no B2C/B2B dimension, so bucket figures use tax-exclusive revenue-share
	allocation — aggregate values are exact; per-bucket carries that caveat. The
	intermediate PBT isn't shown on the dashboard (it sits inside this function's
	response for callers that want it) — the UI jumps EBIT → PAT with the Interest
	and Tax amounts visible in the tile meta + provenance footer.
	"""
	operating_accounts = {
		"salary": get_configured_accounts("salary_accounts"),
		"rent": get_configured_accounts("rent_accounts"),
		"utility": get_configured_accounts("utility_accounts"),
		"admin": get_configured_accounts("admin_overhead_accounts"),
	}
	da_accounts = get_configured_accounts("depreciation_amortization_accounts")
	interest_accounts = get_configured_accounts("interest_and_finance_accounts")
	tax_accounts = get_configured_accounts("tax_expense_accounts")

	def _spend(accounts: list[str]) -> float:
		return _gl_spend(accounts, period.from_date, period.to_date, company)

	salary_total = _spend(operating_accounts["salary"])
	rent_total = _spend(operating_accounts["rent"])
	utility_total = _spend(operating_accounts["utility"])
	admin_total = _spend(operating_accounts["admin"])
	operating_total = salary_total + rent_total + utility_total + admin_total
	da_total = _spend(da_accounts)
	interest_total = _spend(interest_accounts)
	tax_total = _spend(tax_accounts)

	rev_overall = rev_buckets_excl.get("total", 0.0)
	rev_b2c = rev_buckets_excl.get("b2c", 0.0)
	rev_b2b = rev_buckets_excl.get("b2b", 0.0)

	def _share(part: float) -> float:
		return (part / rev_overall) if rev_overall else 0.0

	def _pack(cm3: float, rev: float, share: float) -> dict:
		ebitda = cm3 - operating_total * share
		ebit = ebitda - da_total * share
		pbt = ebit - interest_total * share
		pat = pbt - tax_total * share

		def _pct(x: float) -> float:
			return (x / rev * 100) if rev else 0.0

		return {
			"ebitda": ebitda,
			"ebitda_pct": _pct(ebitda),
			"ebit": ebit,
			"ebit_pct": _pct(ebit),
			"pbt": pbt,
			"pbt_pct": _pct(pbt),
			"pat": pat,
			"pat_pct": _pct(pat),
		}

	return {
		"overall": _pack(cm3_overall, rev_overall, 1.0),
		"b2c": _pack(cm3_b2c, rev_b2c, _share(rev_b2c)),
		"b2b": _pack(cm3_b2b, rev_b2b, _share(rev_b2b)),
		"inputs": {
			"salary_total": salary_total,
			"rent_total": rent_total,
			"utility_total": utility_total,
			"admin_total": admin_total,
			"operating_total": operating_total,
			"da_total": da_total,
			"interest_total": interest_total,
			"tax_total": tax_total,
			"salary_accounts": operating_accounts["salary"],
			"rent_accounts": operating_accounts["rent"],
			"utility_accounts": operating_accounts["utility"],
			"admin_accounts": operating_accounts["admin"],
			"da_accounts": da_accounts,
			"interest_accounts": interest_accounts,
			"tax_accounts": tax_accounts,
			"allocation_basis": "tax-excl revenue share",
			"company_scope": company,
		},
	}


def _cm2(
	period: Period,
	company: str,
	rev_buckets_excl: dict[str, float],
	margin: dict,
) -> dict:
	"""CM2 = CM1 − Freight − Packaging − Transaction Fees − Trade Schemes.

	CM1 is Gross Profit (revenue − COGS). CM2 removes variable fulfillment costs that
	vary with each sale: outbound logistics, secondary packaging, payment/marketplace
	transaction fees, and any off-invoice trade schemes. Marketing is *not* deducted
	here — that belongs to CM3.

	All four deductions come from GL Entry against admin-configured accounts in
	``Company Dashboard Settings``. GL carries no B2C/B2B dimension, so bucket figures
	use tax-exclusive revenue-share allocation — aggregate is exact; per-bucket carries
	that caveat.
	"""
	freight_accounts = get_configured_accounts("outbound_freight_accounts")
	packaging_accounts = get_configured_accounts("packaging_overhead_accounts")
	commission_accounts = get_configured_accounts("marketplace_commission_accounts")
	scheme_accounts = get_configured_accounts("trade_scheme_accounts")

	freight_total = _gl_spend(freight_accounts, period.from_date, period.to_date, company)
	packaging_total = _gl_spend(packaging_accounts, period.from_date, period.to_date, company)
	commission_total = _gl_spend(commission_accounts, period.from_date, period.to_date, company)
	scheme_total = _gl_spend(scheme_accounts, period.from_date, period.to_date, company)
	variable_total = freight_total + packaging_total + commission_total + scheme_total

	rev_overall = rev_buckets_excl.get("total", 0.0)
	rev_b2c = rev_buckets_excl.get("b2c", 0.0)
	rev_b2b = rev_buckets_excl.get("b2b", 0.0)

	def _share(part: float) -> float:
		return (part / rev_overall) if rev_overall else 0.0

	share_b2c = _share(rev_b2c)
	share_b2b = _share(rev_b2b)

	def _pack(gp: float, deduction: float, rev: float) -> dict:
		cm2 = gp - deduction
		pct = (cm2 / rev * 100) if rev else 0.0
		return {"cm2": cm2, "cm2_pct": pct, "deduction": deduction}

	return {
		"overall": _pack(margin["gross_profit"], variable_total, rev_overall),
		"b2c": _pack(margin["b2c"]["gross_profit"], variable_total * share_b2c, rev_b2c),
		"b2b": _pack(margin["b2b"]["gross_profit"], variable_total * share_b2b, rev_b2b),
		"inputs": {
			"freight_total": freight_total,
			"packaging_total": packaging_total,
			"commission_total": commission_total,
			"scheme_total": scheme_total,
			"variable_total": variable_total,
			"freight_accounts": freight_accounts,
			"packaging_accounts": packaging_accounts,
			"commission_accounts": commission_accounts,
			"scheme_accounts": scheme_accounts,
			"allocation_basis": "tax-excl revenue share",
			"company_scope": company,
		},
	}


def _cm3(
	period: Period,
	company: str,
	rev_buckets_excl: dict[str, float],
	cm2_overall: float,
	cm2_b2c: float,
	cm2_b2b: float,
) -> dict:
	"""CM3 = CM2 − Marketing.

	Marketing spend (online + offline — performance ads, brand, promotions, trade
	marketing) is subtracted from CM2 to expose whether customer acquisition is
	profitable. Fixed operating costs (salary, rent, utilities, admin) belong to
	EBITDA, not CM3 — they live under their own section in settings for a future tile.
	"""
	marketing_accounts = get_configured_accounts("marketing_accounts")
	marketing_total = _gl_spend(marketing_accounts, period.from_date, period.to_date, company)

	rev_overall = rev_buckets_excl.get("total", 0.0)
	rev_b2c = rev_buckets_excl.get("b2c", 0.0)
	rev_b2b = rev_buckets_excl.get("b2b", 0.0)

	def _share(part: float) -> float:
		return (part / rev_overall) if rev_overall else 0.0

	def _pack(cm2: float, deduction: float, rev: float) -> dict:
		cm3 = cm2 - deduction
		pct = (cm3 / rev * 100) if rev else 0.0
		return {"cm3": cm3, "cm3_pct": pct, "deduction": deduction}

	return {
		"overall": _pack(cm2_overall, marketing_total, rev_overall),
		"b2c": _pack(cm2_b2c, marketing_total * _share(rev_b2c), rev_b2c),
		"b2b": _pack(cm2_b2b, marketing_total * _share(rev_b2b), rev_b2b),
		"inputs": {
			"marketing_total": marketing_total,
			"marketing_accounts": marketing_accounts,
			"allocation_basis": "tax-excl revenue share",
			"company_scope": company,
		},
	}


def _excluded_customer_stats(period: Period, amt_expr: str) -> dict:
	"""How much revenue was dropped because of the internal-customer filter."""
	rows = frappe.db.sql(
		f"""
		select
			count(distinct si.name)                           as invoices,
			coalesce(sum({amt_expr}), 0)                      as amt
		from `tabSales Invoice Item` sii
		join `tabSales Invoice`   si on si.name = sii.parent
		left join `tabCustomer`   c  on c.name  = si.customer
		where si.docstatus = 1
		  and si.is_return = 0
		  and si.posting_date between %(from)s and %(to)s
		  and (coalesce(c.is_internal_customer, 0) = 1
		       or coalesce(c.is_bns_internal_customer, 0) = 1)
		""",
		{"from": period.from_date, "to": period.to_date},
		as_dict=True,
	)
	if not rows:
		return {"invoices": 0, "amount": 0.0}
	return {"invoices": int(rows[0]["invoices"]), "amount": flt(rows[0]["amt"])}


def _default_company() -> str:
	"""Prefer the ERPNext global default; fallback to first non-disabled Company."""
	company = frappe.defaults.get_global_default("company")
	if company:
		return company
	rows = frappe.get_all(
		"Company", fields=["name"], filters={"disabled": 0}, order_by="creation asc", limit=1
	)
	return rows[0]["name"] if rows else "Company"


@frappe.whitelist()
def get_fiscal_years() -> list[dict]:
	"""List of non-disabled Fiscal Years, newest first, for the period picker."""
	_require_login()
	rows = frappe.get_all(
		"Fiscal Year",
		filters={"disabled": 0},
		fields=["name", "year_start_date", "year_end_date"],
		order_by="year_start_date desc",
	)
	return [
		{
			"name": r["name"],
			"from": r["year_start_date"].isoformat() if r["year_start_date"] else None,
			"to": r["year_end_date"].isoformat() if r["year_end_date"] else None,
		}
		for r in rows
	]


@frappe.whitelist()
def get_overview(
	tax_mode: str = "incl",
	from_date: str | None = None,
	to_date: str | None = None,
) -> dict:
	"""Overview KPIs + monthly trend + category mix.

	``tax_mode`` is ``"incl"`` (default) or ``"excl"``. ``from_date`` / ``to_date``
	override the default Trailing-12-Months window — pass either a fiscal-year range
	from ``get_fiscal_years`` or custom ISO dates. Prior-period values for YoY deltas
	are computed as the same-length window immediately preceding ``from_date``.
	"""
	_require_login()
	if not _erpnext_installed():
		frappe.throw(_("ERPNext is not installed on this site."))

	mode = tax_mode if tax_mode in TAX_MODES else "incl"
	amt_expr = TAX_MODES[mode]
	company = _default_company()

	if from_date and to_date:
		period = _custom_window(getdate(from_date), getdate(to_date))
	else:
		period = _ttm_window()
	cur = _revenue_by_bucket(period.from_date, period.to_date, amt_expr)
	prior = _revenue_by_bucket(period.prior_from, period.prior_to, amt_expr)

	# Margin and CM tiers are ALWAYS computed tax-exclusive regardless of display tax_mode.
	# COGS (incoming_rate) and GL deductions are net of GST; matching them against
	# tax-inclusive revenue would inflate margin by the GST%. Revenue *display* still
	# honours tax_mode.
	# CM ladder:
	#   CM1 = Gross Margin = (Revenue − COGS) / Revenue               ← = margin
	#   CM2 = CM1 − freight − packaging − txn fees − schemes          ← variable fulfillment
	#   CM3 = CM2 − marketing                                         ← customer acquisition
	margin = _gross_margin(period, AMT_EXCL)
	rev_excl = _revenue_by_bucket(period.from_date, period.to_date, AMT_EXCL)
	cm2 = _cm2(period, company, rev_excl, margin)
	cm3 = _cm3(
		period,
		company,
		rev_excl,
		cm2["overall"]["cm2"],
		cm2["b2c"]["cm2"],
		cm2["b2b"]["cm2"],
	)
	ladder = _ebitda_ebit_pat(
		period,
		company,
		rev_excl,
		cm3["overall"]["cm3"],
		cm3["b2c"]["cm3"],
		cm3["b2b"]["cm3"],
	)
	active_skus, avg_mrp = _active_sku_stats(period)
	monthly = _monthly_revenue(period, amt_expr)
	categories = _categories_from_item_group(period, amt_expr)
	excluded = _excluded_customer_stats(period, amt_expr)

	return {
		"period": period.as_dict(),
		"company": company,
		"tax_mode": mode,
		"kpi": {
			"total_revenue": cur["total"],
			"total_revenue_prior": prior["total"],
			"b2c_revenue": cur["b2c"],
			"b2c_revenue_prior": prior["b2c"],
			"b2b_revenue": cur["b2b"],
			"b2b_revenue_prior": prior["b2b"],
			"unclassified_revenue": cur["unclassified"],
			"gross_profit": margin["gross_profit"],
			"gross_margin_pct": margin["gross_margin_pct"],
			"gross_margin_coverage_pct": margin["coverage_pct"],
			"b2c_gross_profit": margin["b2c"]["gross_profit"],
			"b2c_gross_margin_pct": margin["b2c"]["gross_margin_pct"],
			"b2c_gross_margin_coverage_pct": margin["b2c"]["coverage_pct"],
			"b2b_gross_profit": margin["b2b"]["gross_profit"],
			"b2b_gross_margin_pct": margin["b2b"]["gross_margin_pct"],
			"b2b_gross_margin_coverage_pct": margin["b2b"]["coverage_pct"],
			# CM1 ≡ Gross Margin — surfaced as a separate field so the UI can reason about
			# the CM ladder without re-deriving it.
			"cm1": margin["gross_profit"],
			"cm1_pct": margin["gross_margin_pct"],
			"b2c_cm1": margin["b2c"]["gross_profit"],
			"b2c_cm1_pct": margin["b2c"]["gross_margin_pct"],
			"b2b_cm1": margin["b2b"]["gross_profit"],
			"b2b_cm1_pct": margin["b2b"]["gross_margin_pct"],
			# CM2 = CM1 − variable fulfillment (freight + packaging + txn fees + schemes)
			"cm2": cm2["overall"]["cm2"],
			"cm2_pct": cm2["overall"]["cm2_pct"],
			"cm2_deduction": cm2["overall"]["deduction"],
			"b2c_cm2": cm2["b2c"]["cm2"],
			"b2c_cm2_pct": cm2["b2c"]["cm2_pct"],
			"b2b_cm2": cm2["b2b"]["cm2"],
			"b2b_cm2_pct": cm2["b2b"]["cm2_pct"],
			# CM3 = CM2 − marketing
			"cm3": cm3["overall"]["cm3"],
			"cm3_pct": cm3["overall"]["cm3_pct"],
			"cm3_deduction": cm3["overall"]["deduction"],
			"b2c_cm3": cm3["b2c"]["cm3"],
			"b2c_cm3_pct": cm3["b2c"]["cm3_pct"],
			"b2b_cm3": cm3["b2b"]["cm3"],
			"b2b_cm3_pct": cm3["b2b"]["cm3_pct"],
			# EBITDA / EBIT / PAT — below CM3 P&L ladder
			"ebitda": ladder["overall"]["ebitda"],
			"ebitda_pct": ladder["overall"]["ebitda_pct"],
			"b2c_ebitda": ladder["b2c"]["ebitda"],
			"b2c_ebitda_pct": ladder["b2c"]["ebitda_pct"],
			"b2b_ebitda": ladder["b2b"]["ebitda"],
			"b2b_ebitda_pct": ladder["b2b"]["ebitda_pct"],
			"ebit": ladder["overall"]["ebit"],
			"ebit_pct": ladder["overall"]["ebit_pct"],
			"b2c_ebit": ladder["b2c"]["ebit"],
			"b2c_ebit_pct": ladder["b2c"]["ebit_pct"],
			"b2b_ebit": ladder["b2b"]["ebit"],
			"b2b_ebit_pct": ladder["b2b"]["ebit_pct"],
			"pbt": ladder["overall"]["pbt"],
			"pbt_pct": ladder["overall"]["pbt_pct"],
			"pat": ladder["overall"]["pat"],
			"pat_pct": ladder["overall"]["pat_pct"],
			"b2c_pat": ladder["b2c"]["pat"],
			"b2c_pat_pct": ladder["b2c"]["pat_pct"],
			"b2b_pat": ladder["b2b"]["pat"],
			"b2b_pat_pct": ladder["b2b"]["pat_pct"],
			"active_skus": active_skus,
			"avg_mrp": avg_mrp,
		},
		"cm2_inputs": cm2["inputs"],
		"cm3_inputs": cm3["inputs"],
		"ladder_inputs": ladder["inputs"],
		"monthly": monthly,
		"categories": categories,
		"settings": {
			"outbound_freight_accounts": get_configured_accounts("outbound_freight_accounts"),
			"packaging_overhead_accounts": get_configured_accounts("packaging_overhead_accounts"),
		},
		"debug": {
			"classification": "Item.custom_sales_intent (B2C*/B2B*)",
			"tax_mode": mode,
			"excluded_internal": excluded,
			"generated_at": datetime.now(timezone.utc).isoformat(),
		},
	}
