"""Financial statements and drill-downs for the dashboard.

Everything here is built on the same primitives as ``mis.py`` (``_sales_lines``,
``_pl_breakdown``, ``_ladder``, ``_pnl_steps``), so the numbers on the statements, the
overview tiles and the drill pages are the same numbers:

- ``get_pnl_statement``  — the CM ladder month by month; columns add up to the total,
  and the total equals the overview (and GL net profit).
- ``get_ledger_detail``  — one GL account (or a group of accounts): opening, movement,
  closing, monthly trend and the vouchers behind it, with links into ERPNext.
- ``get_revenue_detail`` — the invoices behind revenue (optionally one income account
  or one B2C/B2B bucket).
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import date
from urllib.parse import quote, urlencode

import frappe
from frappe import _
from frappe.utils import add_months, cint, flt, getdate

from company_dashboard.api.mis import (
	AMT_EXCL,
	BUCKETS,
	SII_BASE_FROM,
	TAX_MODES,
	Period,
	_base_where,
	_finance_book_clause,
	_intent_bucket_sql,
	_ladder,
	_period_dict,
	_period_for,
	_pl_breakdown,
	_pnl_steps,
	_require_dashboard_access,
	_require_mis_access,
	_resolve_company,
	_sales_lines,
	_ttm_cache_anchor,
	has_wc_access,
)

# Account types a Working-Capital-only viewer may drill into.
WC_ACCOUNT_TYPES = frozenset({"Bank", "Cash", "Receivable", "Payable", "Stock"})
MAX_PAGE = 200


# ── links ───────────────────────────────────────────────────────────────────


def desk_url(doctype: str, name: str) -> str:
	"""Relative desk URL of a document, e.g. /app/sales-invoice/SINV-0001."""
	return f"/app/{frappe.scrub(doctype).replace('_', '-')}/{quote(name, safe='')}"


def gl_report_url(
	company: str, accounts: list[str], from_date, to_date, voucher_no: str | None = None
) -> str:
	"""Desk General Ledger report filtered to accounts and dates."""
	params = {
		"company": company,
		"from_date": str(from_date),
		"to_date": str(to_date),
		"account": json.dumps(accounts),
		"group_by": "Group by Voucher (Consolidated)",
	}
	if voucher_no:
		params["voucher_no"] = voucher_no
	return "/app/query-report/General%20Ledger?" + urlencode(params)


def _month_keys(from_date: date, to_date: date) -> list[str]:
	keys, cursor = [], from_date.replace(day=1)
	while cursor <= to_date:
		keys.append(f"{cursor.year}-{cursor.month:02d}")
		cursor = getdate(add_months(cursor, 1))
	return keys


# ── Monthly P&L statement ──────────────────────────────────────────────────


def _monthly_pl_balances(company: str, from_date: date, to_date: date) -> dict[str, dict[str, frappe._dict]]:
	"""month → account → {root_type, account_type, account_name, net}, same filters as
	``mis._gl_pl_balances``."""
	params: dict = {"company": company, "from": from_date, "to": to_date}
	fb = _finance_book_clause(company, params)
	rows = frappe.db.sql(
		f"""
		select ge.account, acc.root_type, acc.account_type, acc.account_name,
		       date_format(ge.posting_date, '%%Y-%%m') as ym,
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
		group by ge.account, acc.root_type, acc.account_type, acc.account_name, ym
		""",
		params,
		as_dict=True,
	)
	out: dict[str, dict[str, frappe._dict]] = defaultdict(dict)
	for r in rows:
		out[r.ym][r.account] = frappe._dict(
			account=r.account,
			root_type=r.root_type,
			account_type=r.account_type,
			account_name=r.account_name,
			net=flt(r.net),
		)
	return out


def _overall_steps(company: str, lines, balances: dict | None, period: Period | None) -> list[dict]:
	"""Overall CM ladder steps for a set of invoice lines and P&L balances."""
	rev = dict.fromkeys(BUCKETS, 0.0)
	cost = dict.fromkeys(BUCKETS, 0.0)
	for ln in lines:
		rev[ln.bucket] += ln.rev_excl
		cost[ln.bucket] += ln.allocated_cost
	rev["overall"] = sum(rev[b] for b in BUCKETS)
	pl = _pl_breakdown(company, period, rev["overall"], balances=balances)
	return _pnl_steps(_ladder(rev, cost, pl)["overall"], pl), pl


def _compute_pnl_statement(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	company: str | None = None,
) -> dict:
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	months = _month_keys(period.from_date, period.to_date)
	lines = _sales_lines(company, period.from_date, period.to_date)
	by_month_lines = defaultdict(list)
	for ln in lines:
		by_month_lines[ln.month].append(ln)
	monthly_bal = _monthly_pl_balances(company, period.from_date, period.to_date)

	total_steps, pl = _overall_steps(company, lines, None, period)
	rows = [
		{
			"key": st["key"],
			"label": st["label"],
			"kind": st["kind"],
			"group": st.get("group"),
			"formula": st.get("formula"),
			"values": {},
			"pct": {},
			"total": st["amount"],
			"total_pct": st["pct"],
		}
		for st in total_steps
	]
	revenue_by_month: dict[str, float] = {}
	for ym in months:
		steps, _pl = _overall_steps(company, by_month_lines.get(ym, []), monthly_bal.get(ym, {}), None)
		revenue_by_month[ym] = steps[0]["amount"]
		for row, st in zip(rows, steps, strict=True):
			row["values"][ym] = st["amount"]
			row["pct"][ym] = st["pct"]

	# Same window one year earlier, when the site has data for all of it.
	info = _period_dict(period, company)
	prior = None
	if info["prior"]["available"]:
		prior_lines = _sales_lines(company, period.prior_from, period.prior_to)
		prior_steps, _p = _overall_steps(
			company,
			prior_lines,
			None,
			Period(period.prior_from, period.prior_to, period.prior_from, period.prior_to, "", "custom"),
		)
		prior = {st["key"]: st["amount"] for st in prior_steps}
		for row in rows:
			p = prior.get(row["key"])
			row["prior_total"] = p
			row["change"] = (row["total"] - p) if p is not None else None
			row["change_pct"] = ((row["total"] - p) / abs(p) * 100) if p else None

	# Proof: months add up to the total, and the total is GL net profit.
	drift = max(abs(sum(r["values"].values()) - r["total"]) for r in rows)
	return {
		"period": info,
		"company": company,
		"basis": {"revenue": "excl", "margins": "excl"},
		"tax_mode": tax_mode if tax_mode in TAX_MODES else "excl",
		"months": [
			{
				"key": ym,
				"label": f"{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][int(ym[5:]) - 1]} '{ym[2:4]}",
				"partial": (ym == months[-1] and info["last_month_partial"])
				or (ym == months[0] and period.from_date.day != 1),
				"revenue": revenue_by_month[ym],
			}
			for ym in months
		],
		"rows": rows,
		"checks": {
			"months_sum_to_total": drift < 0.5,
			"max_drift": drift,
			"pat": rows[-1]["total"],
			"gl_net_profit": pl["gl_net_profit"],
			"pat_equals_gl": abs(rows[-1]["total"] - pl["gl_net_profit"]) < 0.5,
		},
		"warnings": pl["warnings"],
	}


@frappe.whitelist()
def get_pnl_statement(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	company: str | None = None,
) -> dict:
	"""Monthly P&L statement (CM ladder × months, ex-tax) with total and prior-year column."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	kwargs = {"tax_mode": tax_mode, "from_date": from_date, "to_date": to_date, "company": company}
	params = {**kwargs, **_ttm_cache_anchor(from_date, to_date)}
	return _cached(
		"mis",
		"pnl_statement",
		lambda: _compute_pnl_statement(**kwargs),
		params,
		job=("company_dashboard.api.finance._compute_pnl_statement", kwargs),
	)


# ── Ledger drill-down ──────────────────────────────────────────────────────


def _check_account_access(acc: frappe._dict) -> None:
	from company_dashboard.api.mis import MIS_ACCESS_ROLES

	user = frappe.session.user
	if user == "Administrator" or set(frappe.get_roles(user)) & MIS_ACCESS_ROLES:
		return
	if has_wc_access() and acc.account_type in WC_ACCOUNT_TYPES:
		return
	frappe.throw(
		_("You don't have access to account {0} on the dashboard.").format(acc.name), frappe.PermissionError
	)


def _window(from_date: str | None, to_date: str | None) -> tuple[date, date]:
	period = _period_for(from_date, to_date)
	return period.from_date, period.to_date


@frappe.whitelist()
def get_ledger_detail(
	account: str,
	from_date: str | None = None,
	to_date: str | None = None,
	company: str | None = None,
	start: int = 0,
	page_length: int = 50,
	order_by: str = "amount",
) -> dict:
	"""One account (a group account covers all its leaves): opening, debit, credit,
	closing, a monthly trend and the vouchers behind the movement (largest first, or
	newest first with ``order_by="date"``)."""
	_require_dashboard_access()
	company = _resolve_company(company)
	acc = frappe.db.get_value(
		"Account",
		account,
		[
			"name",
			"account_name",
			"root_type",
			"account_type",
			"report_type",
			"is_group",
			"company",
			"lft",
			"rgt",
			"parent_account",
		],
		as_dict=True,
	)
	if not acc or acc.company != company:
		frappe.throw(_("Account {0} does not belong to {1}.").format(account, company))
	_check_account_access(acc)
	f, t = _window(from_date, to_date)
	start, page_length = max(cint(start), 0), min(max(cint(page_length), 1), MAX_PAGE)

	leaves = (
		frappe.get_all(
			"Account",
			filters={"company": company, "is_group": 0, "lft": (">", acc.lft), "rgt": ("<", acc.rgt)},
			pluck="name",
		)
		if acc.is_group
		else [acc.name]
	)
	if not leaves:
		leaves = [acc.name]
	is_pl = acc.report_type == "Profit and Loss" or acc.root_type in ("Income", "Expense")
	params: dict = {"accounts": tuple(leaves), "company": company, "from": f, "to": t}
	fb = _finance_book_clause(company, params)
	# P&L accounts: Period Closing Vouchers would zero them, so they're left out (as on the
	# P&L). Balance-sheet accounts: every entry counts, opening included.
	pcv = "and ge.voucher_type != 'Period Closing Voucher'" if is_pl else ""
	base = f"ge.account in %(accounts)s and ge.company = %(company)s and ge.is_cancelled = 0 {fb}"

	opening = 0.0
	if not is_pl:
		opening = flt(
			frappe.db.sql(
				f"select coalesce(sum(ge.debit) - sum(ge.credit), 0) from `tabGL Entry` ge where {base} and ge.posting_date < %(from)s",
				params,
			)[0][0]
		)
	totals = frappe.db.sql(
		f"""
		select coalesce(sum(ge.debit), 0), coalesce(sum(ge.credit), 0), count(distinct ge.voucher_no)
		from `tabGL Entry` ge
		where {base} and ge.posting_date between %(from)s and %(to)s {pcv}
		""",
		params,
	)[0]
	debit, credit, voucher_count = flt(totals[0]), flt(totals[1]), cint(totals[2])

	monthly = {
		ym: flt(net)
		for ym, net in frappe.db.sql(
			f"""
			select date_format(ge.posting_date, '%%Y-%%m'), sum(ge.debit) - sum(ge.credit)
			from `tabGL Entry` ge
			where {base} and ge.posting_date between %(from)s and %(to)s {pcv}
			group by 1
			""",
			params,
		)
	}
	net_expr = "sum(ge.debit) - sum(ge.credit)"
	order = (
		f"min(ge.posting_date) desc, {net_expr} desc"
		if order_by == "date"
		else f"abs({net_expr}) desc, min(ge.posting_date) desc"
	)
	vouchers = frappe.db.sql(
		f"""
		select ge.voucher_type, ge.voucher_no, min(ge.posting_date) as posting_date,
		       max(ge.party_type) as party_type, max(ge.party) as party,
		       max(ge.against) as against, max(ge.remarks) as remarks,
		       sum(ge.debit) as debit, sum(ge.credit) as credit,
		       sum(ge.debit) - sum(ge.credit) as net
		from `tabGL Entry` ge
		where {base} and ge.posting_date between %(from)s and %(to)s {pcv}
		group by ge.voucher_type, ge.voucher_no
		order by {order}
		limit %(limit)s offset %(offset)s
		""",
		{**params, "limit": page_length, "offset": start},
		as_dict=True,
	)
	for v in vouchers:
		v.debit, v.credit, v.net = flt(v.debit), flt(v.credit), flt(v.net)
		v.remarks = (v.remarks or "")[:240]
		v.against = (v.against or "")[:160]
		v.url = desk_url(v.voucher_type, v.voucher_no)
		v.posting_date = str(v.posting_date)

	movement = debit - credit
	return {
		"company": company,
		"account": {
			**acc,
			"leaf_count": len(leaves),
			"url": desk_url("Account", acc.name),
			"is_pl": is_pl,
		},
		"from": str(f),
		"to": str(t),
		"opening": opening,
		"debit": debit,
		"credit": credit,
		"movement": movement,
		"closing": opening + movement,
		"monthly": [{"key": ym, "net": monthly.get(ym, 0.0)} for ym in _month_keys(f, t)],
		"vouchers": vouchers,
		"voucher_count": voucher_count,
		"start": start,
		"page_length": page_length,
		"gl_report_url": gl_report_url(company, [acc.name], f, t),
	}


@frappe.whitelist()
def get_revenue_detail(
	from_date: str | None = None,
	to_date: str | None = None,
	company: str | None = None,
	income_account: str | None = None,
	bucket: str | None = None,
	start: int = 0,
	page_length: int = 50,
) -> dict:
	"""Invoices behind revenue (ex-tax, returns included), optionally one income account
	and/or one bucket (b2c / b2b / unclassified). Same filters as the revenue figure."""
	_require_mis_access()
	company = _resolve_company(company)
	f, t = _window(from_date, to_date)
	start, page_length = max(cint(start), 0), min(max(cint(page_length), 1), MAX_PAGE)
	params: dict = {}
	where = _base_where(params, company, f, t)
	if income_account:
		params["income_account"] = income_account
		where += " and sii.income_account = %(income_account)s"
	if bucket in BUCKETS:
		params["bucket"] = bucket
		where += f" and ({_intent_bucket_sql('b').rsplit(' as ', 1)[0]}) = %(bucket)s"
	totals = frappe.db.sql(
		f"select coalesce(sum({AMT_EXCL}), 0), count(distinct si.name) from {SII_BASE_FROM} where {where}",
		params,
	)[0]
	rows = frappe.db.sql(
		f"""
		select si.name as invoice, si.posting_date, si.customer,
		       coalesce(c.customer_name, si.customer_name, si.customer) as customer_name,
		       si.is_return, count(*) as line_count, coalesce(sum({AMT_EXCL}), 0) as revenue
		from {SII_BASE_FROM}
		where {where}
		group by si.name, si.posting_date, si.customer, customer_name, si.is_return
		order by abs(coalesce(sum({AMT_EXCL}), 0)) desc
		limit %(limit)s offset %(offset)s
		""",
		{**params, "limit": page_length, "offset": start},
		as_dict=True,
	)
	for r in rows:
		r.revenue = flt(r.revenue)
		r.posting_date = str(r.posting_date)
		r.url = desk_url("Sales Invoice", r.invoice)
	return {
		"company": company,
		"from": str(f),
		"to": str(t),
		"income_account": income_account,
		"bucket": bucket if bucket in BUCKETS else None,
		"total": flt(totals[0]),
		"invoice_count": cint(totals[1]),
		"invoices": rows,
		"start": start,
		"page_length": page_length,
		"report_url": "/app/query-report/Sales%20Register?"
		+ urlencode({"company": company, "from_date": str(f), "to_date": str(t)}),
	}
