"""Run ERPNext's own financial reports so the dashboard can prove it matches them.

Notes from reading the v15/v16 report code (kept here because they explain every gap):

- The reports read GL through ``frappe.get_list``-style permission conditions, so they
  are run with full read access; callers have already passed the dashboard role check.
- P&L / Balance Sheet with a Date Range snap the period end to the end of its month, and
  round every figure to 3 decimals. P&L counts opening entries dated inside the range.
- Balance Sheet must use ``accumulated_values=1``; its "Provisional Profit / Loss" covers
  the current year plus every earlier year not closed by a Period Closing Voucher.
- Cash Flow only knows Receivable / Payable / Stock / Depreciation / Fixed Asset / Equity
  account types, so it ignores every other balance-sheet account and does not tie to cash.
- Gross Profit's "buying amount" values returns at the original sale rate, non-stock
  items at the last purchase rate, and never sees stock adjustments or non-sales COGS.
"""

from __future__ import annotations

from datetime import date

import frappe
from frappe.utils import flt

from company_dashboard.api.mis import _finance_book_clause
from company_dashboard.api.wc import _as_administrator


def _summary_value(summary: list, idx: int) -> float:
	try:
		return flt(summary[idx].get("value"))
	except (IndexError, AttributeError, TypeError):
		return 0.0


def _fy_start(company: str, d: date) -> date:
	from company_dashboard.api.statements import _fy_bounds

	return _fy_bounds(company, d)[0]


def profit_and_loss_net(company: str, from_date: date, to_date: date) -> dict:
	from erpnext.accounts.report.profit_and_loss_statement.profit_and_loss_statement import execute

	filters = {
		"company": company,
		"filter_based_on": "Date Range",
		"period_start_date": from_date.isoformat(),
		"period_end_date": to_date.isoformat(),
		"periodicity": "Yearly",
		"accumulated_values": 0,
		"include_default_book_entries": 1,
		"selected_view": "Report",
	}
	with _as_administrator():
		res = execute(frappe._dict(filters))
	summary = res[4] if len(res) > 4 else []
	return {
		"net_profit": _summary_value(summary, 2),
		"income": _summary_value(summary, 0),
		"expense": _summary_value(summary, 1),
		"filters": filters,
		"note": "ERPNext rounds to 3 decimals, snaps the period end to the month end and counts opening entries dated inside the range.",
	}


def balance_sheet_totals(company: str, as_of: date) -> dict:
	from erpnext.accounts.report.balance_sheet.balance_sheet import execute

	filters = {
		"company": company,
		"filter_based_on": "Date Range",
		"period_start_date": _fy_start(company, as_of).isoformat(),
		"period_end_date": as_of.isoformat(),
		"periodicity": "Yearly",
		"accumulated_values": 1,
		"include_default_book_entries": 1,
	}
	with _as_administrator():
		res = execute(frappe._dict(filters))
	summary = res[4] if len(res) > 4 else []
	return {
		"assets": _summary_value(summary, 0),
		"liabilities": _summary_value(summary, 1),
		"equity": _summary_value(summary, 2),
		"provisional": _summary_value(summary, 3),
		"filters": filters,
		"note": "ERPNext groups by root type (a Capital Account under Liabilities stays a liability there); totals compare one to one.",
	}


def cash_flow_net(company: str, from_date: date, to_date: date) -> dict:
	from erpnext.accounts.report.cash_flow.cash_flow import execute

	filters = {
		"company": company,
		"filter_based_on": "Date Range",
		"period_start_date": from_date.isoformat(),
		"period_end_date": to_date.isoformat(),
		"periodicity": "Yearly",
		"accumulated_values": 0,
		"include_default_book_entries": 1,
		"show_opening_and_closing_balance": 0,
	}
	with _as_administrator():
		res = execute(frappe._dict(filters))
	cols, data = res[0], res[1]
	period_keys = [
		c["fieldname"] for c in cols if c.get("fieldname") not in ("section", "total", None, "currency")
	]
	last = next((r for r in reversed(data) if r and r.get("section")), {})
	value = sum(flt(last.get(k)) for k in period_keys[-1:]) if period_keys else flt(last.get("total"))
	return {"net_change": value, "filters": filters}


def gross_profit_totals(company: str, from_date: date, to_date: date) -> dict:
	"""ERPNext Gross Profit totals, the same invoices' line revenue, and a bridge from
	the report's buying amount to GL cost of goods by voucher type."""
	from erpnext.accounts.report.gross_profit.gross_profit import execute

	filters = {
		"company": company,
		"from_date": from_date.isoformat(),
		"to_date": to_date.isoformat(),
		"group_by": "Invoice",
		"include_returned_invoices": 1,
	}
	with _as_administrator():
		_cols, data = execute(frappe._dict(filters))
	total = next((r for r in reversed(data) if isinstance(r, dict) and r), {})
	selling, buying = flt(total.get("selling_amount")), flt(total.get("buying_amount"))

	dashboard_selling = flt(
		frappe.db.sql(
			"""select coalesce(sum(sii.base_net_amount), 0)
			from `tabSales Invoice Item` sii join `tabSales Invoice` si on si.name = sii.parent
			where si.docstatus = 1 and coalesce(si.is_opening, 'No') != 'Yes'
			  and si.company = %(company)s and si.posting_date between %(from)s and %(to)s""",
			{"company": company, "from": from_date, "to": to_date},
		)[0][0]
	)
	params: dict = {"company": company, "from": from_date, "to": to_date}
	fb = _finance_book_clause(company, params)
	by_voucher = frappe.db.sql(
		f"""
		select ge.voucher_type, coalesce(sum(ge.debit) - sum(ge.credit), 0) as amount
		from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
		where ge.company = %(company)s and ge.is_cancelled = 0
		  and ge.posting_date between %(from)s and %(to)s
		  and ge.voucher_type != 'Period Closing Voucher'
		  and coalesce(ge.is_opening, 'No') = 'No'
		  and a.account_type in ('Cost of Goods Sold', 'Stock Adjustment') {fb}
		group by ge.voucher_type
		order by abs(coalesce(sum(ge.debit) - sum(ge.credit), 0)) desc
		""",
		params,
		as_dict=True,
	)
	gl_cogs = sum(flt(r.amount) for r in by_voucher)
	bridge = [{"label": "ERPNext Gross Profit — buying amount", "amount": buying, "kind": "start"}]
	bridge.append(
		{
			"label": "Valuation differences in the report (returns at original rate, non-stock at last purchase rate, rate cache, DN-dated cost)",
			"amount": flt(next((r.amount for r in by_voucher if r.voucher_type == "Sales Invoice"), 0.0))
			- buying,
			"kind": "adjust",
		}
	)
	for r in by_voucher:
		if r.voucher_type == "Sales Invoice":
			continue
		bridge.append(
			{
				"label": f"GL cost of goods posted by {r.voucher_type}",
				"amount": flt(r.amount),
				"kind": "adjust",
			}
		)
	bridge.append({"label": "GL cost of goods (dashboard)", "amount": gl_cogs, "kind": "end"})
	return {
		"selling_amount": selling,
		"buying_amount": buying,
		"gross_profit": flt(total.get("gross_profit")),
		"dashboard_selling_amount": dashboard_selling,
		"gl_cogs": gl_cogs,
		"gl_cogs_by_voucher_type": [
			{"voucher_type": r.voucher_type, "amount": flt(r.amount)} for r in by_voucher
		],
		"bridge": bridge,
		"bridge_note": "Bridge from the report's buying amount to GL cost of goods. Postings by Purchase Receipts / Invoices or Delivery Notes to cost-of-goods accounts come from stock and internal-transfer flows that the report never sees.",
		"filters": filters,
	}
