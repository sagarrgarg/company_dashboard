"""One-shot MIS exports — Excel workbook and A4 PDF report.

Excel (.xlsx) delivers one sheet per dashboard page:
  Overview KPIs · Monthly Revenue · Revenue by Category · P&L Waterfall ·
  SKU Assortment · Customer Segments · Working Capital (WC viewers only).

PDF is an A4 report (portrait) laid out for printing / board packs: cover
page, CM ladder summary, P&L line-by-line, monthly revenue table, top-10
categories, top-50 SKUs, per-segment snapshot and (WC viewers) working capital.

Both share the same cached payloads the dashboard uses, so every figure matches
the screen. The P&L comes straight from the API's ``pnl`` steps (ex-tax, tied to
GL net profit) — nothing is re-derived here. Amounts use Indian lakh/crore
grouping; filenames are ASCII.
"""

from __future__ import annotations

import base64
import html as _html
import io
import math
import os
import re
import unicodedata
from datetime import datetime, timezone

import frappe
from frappe import _
from frappe.utils.pdf import get_pdf
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from PIL import Image, ImageDraw, ImageFont

from company_dashboard.api.mis import (
	_require_mis_access,
	get_customer_segments,
	get_overview,
	get_sku_assortment,
	has_wc_access,
)

# Green header band matching the dashboard's brand — WCAG-AA against white text.
_HEADER_FILL = PatternFill("solid", fgColor="1F5F33")
_HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
_SECTION_FONT = Font(bold=True, color="1A1810", size=12)
_MUTED_FONT = Font(color="7A6F5D", size=10, italic=True)
_WARN_FONT = Font(color="7A1F1F", size=10, bold=True)
_NUM_FMT_PCT = "0.00%"
_NUM_FMT_INT = "#,##0"
_NUM_FMT_LAKH = "#,##0.00"

_INTENT_LABELS = {"all": "All items", "b2c": "B2C items only", "b2b": "B2B items only"}


def _gather(tax_mode: str, from_date: str | None, to_date: str | None, intent: str, company: str | None) -> dict:
	"""Same cached payloads the dashboard shows, for the caller's filters."""
	overview = get_overview(tax_mode=tax_mode, from_date=from_date, to_date=to_date, company=company)
	company = overview["company"]
	data = {
		"overview": overview,
		"assortment": get_sku_assortment(
			tax_mode=tax_mode, from_date=from_date, to_date=to_date, intent=intent, company=company
		),
		"segments": get_customer_segments(
			tax_mode=tax_mode, from_date=from_date, to_date=to_date, intent=intent, company=company
		),
		"wc": None,
	}
	if has_wc_access():
		from company_dashboard.api.wc import get_wc_snapshot

		data["wc"] = get_wc_snapshot(company)
	return data


def _filename(overview: dict, ext: str) -> str:
	"""ASCII-only filename: MIS_<company>_<from>_<to>.<ext>."""
	raw = f"MIS_{overview['company']}_{overview['period']['from']}_{overview['period']['to']}"
	ascii_only = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
	return re.sub(r"[^A-Za-z0-9._-]+", "_", ascii_only).strip("_") + f".{ext}"


@frappe.whitelist(allow_guest=False)
def download_mis_workbook(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
	company: str | None = None,
) -> None:
	"""Whitelisted endpoint — streams the workbook back to the browser as a download."""
	_require_mis_access()
	data = _gather(tax_mode, from_date, to_date, intent, company)
	overview = data["overview"]

	wb = Workbook()
	wb.remove(wb.active)
	_write_overview_sheet(wb, overview)
	_write_monthly_sheet(wb, overview)
	_write_categories_sheet(wb, overview)
	_write_pnl_sheet(wb, overview)
	_write_assortment_sheet(wb, data["assortment"])
	_write_segments_sheet(wb, data["segments"])
	if data["wc"]:
		_write_wc_sheet(wb, data["wc"])

	buf = io.BytesIO()
	wb.save(buf)
	frappe.response.update(
		{
			"filename": _filename(overview, "xlsx"),
			"filecontent": buf.getvalue(),
			"type": "binary",
			"display_content_as": "attachment",
		}
	)


# ── Number helpers ────────────────────────────────────────────────────────────


def _finite(value) -> bool:
	return value is not None and isinstance(value, int | float) and math.isfinite(value)


def _group_in(n: int) -> str:
	"""Indian digit grouping of a non-negative integer: 12345678 → '1,23,45,678'."""
	s = str(n)
	if len(s) <= 3:
		return s
	head, tail = s[:-3], s[-3:]
	parts = []
	while len(head) > 2:
		parts.insert(0, head[-2:])
		head = head[:-2]
	if head:
		parts.insert(0, head)
	return ",".join(parts) + "," + tail


def _inr(value) -> str:
	"""Screen format: sign first, unit chosen after rounding. ₹1.23 Cr · ₹99.95 L · ₹12,345."""
	if not _finite(value):
		return "—"
	a = abs(float(value))
	lakh = round(a / 1_00_000, 2)
	if lakh >= 100:
		paise_of_crore = round(a / 1_00_000)  # crore with 2 decimals, as an integer
		whole, frac = divmod(paise_of_crore, 100)
		text = f"₹{_group_in(int(whole))}.{int(frac):02d} Cr"
	elif lakh >= 1:
		text = f"₹{lakh:.2f} L"
	else:
		text = f"₹{_group_in(round(a))}"
	return ("−" + text) if value < 0 and text not in ("₹0", "₹0.00 L") else text


def _pct(value, digits: int = 2) -> str:
	if not _finite(value):
		return "n/a"
	return f"{value:.{digits}f}%"


def _frac(value):
	"""Percent → fraction for Excel, or None (blank cell) when not meaningful."""
	return value / 100 if _finite(value) else None


def _inr_numfmt(value) -> str:
	"""Excel format with lakh/crore grouping. Excel can't group 2-2-3 natively for every
	magnitude in one format, so pick one by the cell's magnitude (sign is automatic)."""
	a = abs(value) if _finite(value) else 0
	if a >= 1_00_00_00_000:
		return '"₹"##\\,##\\,##\\,##\\,##0'
	if a >= 1_00_00_000:
		return '"₹"##\\,##\\,##\\,##0'
	if a >= 1_00_000:
		return '"₹"##\\,##\\,##0'
	return '"₹"#,##0'


def _set_inr(cell, value) -> None:
	cell.value = value if _finite(value) else None
	cell.number_format = _inr_numfmt(value)


# ── Sheet writers ─────────────────────────────────────────────────────────────


def _basis_note(res: dict) -> str:
	mode = "tax-inclusive" if res.get("tax_mode") == "incl" else "tax-exclusive"
	return f"Revenue shown {mode}. Every margin and P&L line is tax-exclusive."


def _write_overview_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Overview KPIs")
	kpi = res["kpi"]
	ws.append(["MIS Overview", res["company"]])
	ws["A1"].font = _SECTION_FONT
	ws.append([res["period"]["label"], _basis_note(res)])
	ws["A2"].font = _MUTED_FONT
	ws.append(["Scope", "All items (overview is never filtered by intent)"])
	ws.append([])

	prior_ok = res["period"]["prior"]["available"]
	_section(ws, "Revenue")
	_kv_inr(ws, "Total revenue", kpi["total_revenue"])
	_kv_inr(ws, "Total revenue (ex-tax)", kpi["total_revenue_excl"])
	_kv_inr(
		ws,
		f"Total revenue, {res['period']['comparison_label']}" + ("" if prior_ok else " (prior period incomplete)"),
		kpi["total_revenue_prior"],
	)
	_kv_inr(ws, "B2C revenue", kpi["b2c_revenue"])
	_kv_inr(ws, "B2B revenue", kpi["b2b_revenue"])
	_kv_inr(ws, "Unclassified revenue", kpi["unclassified_revenue"])
	ws.append([])

	_section(ws, "Gross margin (ex-tax)")
	_kv_inr(ws, "Cost of goods (GL)", kpi["cogs"])
	_kv_inr(ws, "  of which tied to invoice lines", kpi["cogs_allocated"])
	_kv_inr(ws, "  of which unallocated", kpi["cogs_unallocated"])
	_kv_inr(ws, "Direct costs", kpi["direct_costs"])
	_kv_inr(ws, "Gross profit (CM1)", kpi["gross_profit"])
	_kv_pct(ws, "Gross margin %", kpi["gross_margin_pct"])
	_kv_pct(ws, "Valuation coverage %", kpi["gross_margin_coverage_pct"])
	for b, label in (("b2c", "B2C"), ("b2b", "B2B"), ("unclassified", "Unclassified")):
		_kv_pct(ws, f"{label} GM %", kpi[f"{b}_gross_margin_pct"])
	ws.append([])

	_section(ws, "Contribution margin ladder (ex-tax)")
	_header_row(ws, ["Tier", "Overall (₹)", "% of revenue", "B2C (₹)", "B2B (₹)", "Unclassified (₹)"])
	for label, key in (
		("CM1 (Gross margin)", "cm1"),
		("CM2 (before marketing)", "cm2"),
		("CM3 (after marketing)", "cm3"),
		("EBITDA", "ebitda"),
		("EBIT", "ebit"),
		("PBT", "pbt"),
		("PAT", "pat"),
	):
		row = ws.max_row + 1
		ws.cell(row=row, column=1, value=label)
		_set_inr(ws.cell(row=row, column=2), kpi[key])
		c = ws.cell(row=row, column=3, value=_frac(kpi[f"{key}_pct"]))
		c.number_format = _NUM_FMT_PCT
		for col, b in ((4, "b2c"), (5, "b2b"), (6, "unclassified")):
			_set_inr(ws.cell(row=row, column=col), kpi[f"{b}_{key}"])
	_kv_inr(ws, "GL net profit (check)", kpi["gl_net_profit"])
	ws.append([])

	_section(ws, "Activity")
	_kv_row(ws, "Active SKUs (stock items with sales)", kpi["active_skus"], _NUM_FMT_INT)
	_kv_inr(ws, "Average MRP per SKU", kpi["avg_mrp"])
	ws.append([])

	_write_quality(ws, res.get("data_quality") or {})
	_write_provenance(ws, res, "CM1 = Revenue − cost of goods (GL) − direct costs · CM2 = − freight/pkg/txn/schemes · CM3 = − marketing")
	_autofit(ws, [44, 18, 14, 16, 16, 16])


def _write_quality(ws, q: dict) -> None:
	if not q:
		return
	_section(ws, "Data quality")
	_kv_row(ws, "Lines kept out of the cost split (impossible cost)", q.get("flagged_lines", 0), _NUM_FMT_INT)
	_kv_inr(ws, "Cost on those lines", q.get("flagged_cost"))
	for w in q.get("warnings") or []:
		ws.append(["Mapping warning", w.get("message")])
		ws.cell(row=ws.max_row, column=2).font = _WARN_FONT
	anomalies = q.get("anomalies") or []
	if anomalies:
		ws.append([])
		_header_row(ws, ["Invoice", "Item", "Month", "Qty", "Revenue (₹)", "Cost (₹)"])
		for a in anomalies[:20]:
			ws.append([a["invoice"], a["item_code"], a["month"], a["qty"]])
			_set_inr(ws.cell(row=ws.max_row, column=5), a["revenue"])
			_set_inr(ws.cell(row=ws.max_row, column=6), a["cost"])
	ws.append([])


def _write_monthly_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Monthly Revenue")
	rows = res.get("monthly", [])
	_header_row(ws, ["Month", "Year", "B2C (₹ L)", "B2B (₹ L)", "Unclassified (₹ L)", "Total (₹ L)", "Note"])
	for r in rows:
		ws.append([r["month"], r["year"], r["b2c"], r["b2b"], r["other"], r["total"], "month to date" if r.get("partial") else ""])
		for col in (3, 4, 5, 6):
			ws.cell(row=ws.max_row, column=col).number_format = _NUM_FMT_LAKH
	last = ws.max_row
	if rows:
		total_row = last + 1
		ws.cell(row=total_row, column=1, value="Total").font = _SECTION_FONT
		for col in (3, 4, 5, 6):
			letter = get_column_letter(col)
			c = ws.cell(row=total_row, column=col, value=f"=SUM({letter}2:{letter}{last})")
			c.font = _SECTION_FONT
			c.number_format = _NUM_FMT_LAKH
	_write_provenance(ws, res, "Revenue in ₹ lakh, net of returns. 'Unclassified' = items without a B2C/B2B sales intent.")
	_autofit(ws, [10, 8, 14, 14, 18, 14, 16])


def _write_categories_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Revenue by Category")
	rows = res.get("categories", [])
	_header_row(ws, ["Category", "SKU count", "Revenue (₹ L)", "% of total"])
	total = sum(r["revenue"] for r in rows) or 1
	for r in rows:
		ws.append([r["category"], r["sku_count"], r["revenue"], r["revenue"] / total])
		ws.cell(row=ws.max_row, column=3).number_format = _NUM_FMT_LAKH
		ws.cell(row=ws.max_row, column=4).number_format = _NUM_FMT_PCT
	total_row = ws.max_row + 1
	ws.cell(row=total_row, column=1, value="Total").font = _SECTION_FONT
	ws.cell(row=total_row, column=3, value=total).font = _SECTION_FONT
	ws.cell(row=total_row, column=3).number_format = _NUM_FMT_LAKH
	ws.cell(row=total_row, column=4, value=1).number_format = _NUM_FMT_PCT
	_write_provenance(ws, res, "Top 10 item groups by revenue; the rest collapsed into 'Other'. SKUs are counted once per group.")
	_autofit(ws, [28, 12, 16, 12])


def _write_pnl_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("P&L Waterfall")
	steps = res["pnl"]["overall"]
	_header_row(ws, ["Line item", "Amount (₹)", "% of revenue", "Detail"])
	for s in steps:
		row = ws.max_row + 1
		indent = "    " if s["kind"] == "deduction" else ""
		ws.cell(row=row, column=1, value=indent + s["label"])
		_set_inr(ws.cell(row=row, column=2), s["amount"])
		c = ws.cell(row=row, column=3, value=_frac(s["pct"]))
		c.number_format = _NUM_FMT_PCT
		ws.cell(row=row, column=4, value=s.get("note") or "")
		if s["kind"] != "deduction":
			for col in range(1, 5):
				ws.cell(row=row, column=col).font = Font(bold=True)
	ws.append([])
	kpi = res["kpi"]
	_kv_inr(ws, "GL net profit", kpi["gl_net_profit"])
	_kv_inr(ws, "Difference (PAT − GL net profit)", kpi["pat_residual"])
	li = res["ladder_inputs"]
	if li.get("unmapped_expense_accounts"):
		ws.append([])
		_section(ws, "Other expenses — unmapped accounts")
		for a in li["unmapped_expense_accounts"]:
			_kv_inr(ws, a["account"], a["amount"])
	if li.get("other_income_accounts") or li.get("revenue_gl_difference"):
		ws.append([])
		_section(ws, "Other income")
		for a in li.get("other_income_accounts") or []:
			_kv_inr(ws, a["account"], a["amount"])
		if li.get("revenue_gl_difference") is not None:
			_kv_inr(ws, "GL sales accounts − invoice-line revenue", li["revenue_gl_difference"])
	ws.append([])
	_write_provenance(ws, res, "Every line is a GL figure, tax-exclusive. PAT equals GL net profit for the company and period.")
	_autofit(ws, [44, 18, 14, 44])


def _write_assortment_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("SKU Assortment")
	rows = res.get("rows", [])
	month_keys = res.get("month_keys", [])
	base_cols = [
		"#", "SKU", "Item name", "Item group", "Intent", "UOM",
		"Units", "Revenue (₹)", "Revenue ex-tax (₹)", "Cost of goods (₹)", "GM %",
		"Freight (₹)", "Packaging (₹)", "Txn fees (₹)", "Scheme (₹)", "Marketing (₹)",
		"CM2 %", "CM3 %", "Flagged cost (₹)",
	]
	_header_row(ws, base_cols + month_keys)
	inr_cols = (8, 9, 10, 12, 13, 14, 15, 16, 19)
	for i, r in enumerate(rows, start=1):
		ws.append([i, r["item_code"], r["item_name"], r["item_group"], r["intent"], r["stock_uom"], r["qty"]])
		rnum = ws.max_row
		ws.cell(row=rnum, column=7).number_format = _NUM_FMT_INT
		values = {
			8: r["revenue"], 9: r["revenue_excl"], 10: r["cogs"], 12: r["alloc_freight"],
			13: r["alloc_packaging"], 14: r["alloc_commission"], 15: r["alloc_scheme"],
			16: r["alloc_marketing"], 19: r["flagged_cost"] or None,
		}
		for col in inr_cols:
			_set_inr(ws.cell(row=rnum, column=col), values[col])
		for col, key in ((11, "gm_pct"), (17, "cm2_pct"), (18, "cm3_pct")):
			c = ws.cell(row=rnum, column=col, value=_frac(r[key]))
			c.number_format = _NUM_FMT_PCT
		for j, mk in enumerate(month_keys):
			_set_inr(ws.cell(row=rnum, column=len(base_cols) + 1 + j), r["monthly"].get(mk, 0.0))

	t = res["totals"]
	ws.append([])
	for label, value in (
		("Total revenue ex-tax", t["revenue_excl"]),
		("Cost of goods on SKU lines", t["cogs"]),
		("Unallocated cost of goods (stock adjustments, JV/PI/PR/SE cost, flagged lines)", t["cogs_unallocated"]),
		("Direct costs", t["direct_costs"]),
		("Gross profit", t["gp"]),
	):
		_kv_inr(ws, label, value)
	_kv_pct(ws, "Gross margin %", t["gm_pct"])
	for uom, qty in (t.get("qty_by_uom") or {}).items():
		_kv_row(ws, f"Units ({uom})", qty, _NUM_FMT_INT)

	ws.freeze_panes = "G2"
	a = res["allocation"]
	_write_provenance(
		ws,
		res,
		f"Scope: {_INTENT_LABELS.get(res.get('intent'), 'All items')}. Cost = stock-ledger value of each line; margins tax-exclusive. "
		f"Allocations of ex-tax revenue: freight {a['freight_pct']:.2f}% · pkg {a['packaging_pct']:.2f}% · "
		f"txn {a['commission_pct']:.2f}% · scheme {a['scheme_pct']:.2f}% · marketing {a['marketing_pct']:.2f}%.",
	)
	_autofit(ws, [5, 14, 32, 18, 14, 8, 10, 15, 15, 15, 9, 13, 13, 13, 12, 14, 9, 9, 14] + [12] * len(month_keys))


def _write_segments_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Customer Segments")
	rows = res.get("segments", [])
	_header_row(
		ws,
		["Segment", "Customers", "Invoices", "Revenue (₹)", "% Mix", "YoY %", "AOV (₹)", "GP (₹)", "GM %", "Cost coverage %"],
	)
	total_rev = res["totals"]["revenue"] or 1
	for r in rows:
		ws.append([r["segment"], r["customers"], r["invoices"]])
		rnum = ws.max_row
		ws.cell(row=rnum, column=2).number_format = _NUM_FMT_INT
		ws.cell(row=rnum, column=3).number_format = _NUM_FMT_INT
		_set_inr(ws.cell(row=rnum, column=4), r["revenue"])
		ws.cell(row=rnum, column=5, value=r["revenue"] / total_rev).number_format = _NUM_FMT_PCT
		ws.cell(row=rnum, column=6, value=_frac(r["yoy_pct"])).number_format = _NUM_FMT_PCT
		_set_inr(ws.cell(row=rnum, column=7), r["aov"])
		_set_inr(ws.cell(row=rnum, column=8), r["gp"])
		ws.cell(row=rnum, column=9, value=_frac(r["gm_pct"])).number_format = _NUM_FMT_PCT
		ws.cell(row=rnum, column=10, value=_frac(r["gm_coverage_pct"])).number_format = _NUM_FMT_PCT

	t = res["totals"]
	ws.append(["Total", t["customers"], t["invoices"]])
	rnum = ws.max_row
	for col in range(1, 11):
		ws.cell(row=rnum, column=col).font = Font(bold=True)
	_set_inr(ws.cell(row=rnum, column=4), t["revenue"])
	_set_inr(ws.cell(row=rnum, column=8), t["gp"])
	ws.cell(row=rnum, column=9, value=_frac(t["gm_pct"])).number_format = _NUM_FMT_PCT
	_kv_inr(ws, "Unallocated cost of goods (not split by segment)", t["cogs_unallocated"])
	_kv_inr(ws, "Gross profit after unallocated cost and direct costs", t["gp_after_unallocated"])

	ws.append([])
	ws.append(["— Top customers per segment —"])
	ws.cell(row=ws.max_row, column=1).font = _SECTION_FONT
	_header_row(ws, ["Segment", "Customer", "Invoices", "Revenue (₹)", "% of segment"])
	for r in rows:
		seg_rev = r["revenue"] or 1
		for c in r["top_customers"][:5]:
			ws.append([r["segment"], c["customer_name"], c["invoices"]])
			rnum = ws.max_row
			ws.cell(row=rnum, column=3).number_format = _NUM_FMT_INT
			_set_inr(ws.cell(row=rnum, column=4), c["revenue"])
			ws.cell(row=rnum, column=5, value=c["revenue"] / seg_rev).number_format = _NUM_FMT_PCT

	scope = (
		f"Scoped to {', '.join(res['scope_roots'])} (descendants rolled up)"
		if res.get("scope_roots")
		else "All customer groups with sales in the period"
	)
	_write_provenance(
		ws,
		res,
		f"{scope}. Scope: {_INTENT_LABELS.get(res.get('intent'), 'All items')}. YoY blank = prior period incomplete. "
		"Segment = customer group on the invoice.",
	)
	_autofit(ws, [30, 12, 12, 16, 10, 10, 14, 14, 10, 14])


def _write_wc_sheet(wb: Workbook, snap: dict) -> None:
	ws = wb.create_sheet("Working Capital")
	o = snap["overview"]
	k = o["kpi"]
	ws.append(["Working capital", o["company"]])
	ws["A1"].font = _SECTION_FONT
	ws.append([f"As of {o['as_of']}", "All balances from the GL"])
	ws["A2"].font = _MUTED_FONT
	ws.append([])

	_section(ws, "Balances")
	for label, key in (
		("Cash and bank", "cash_and_bank"),
		("Overdraft / cash credit (borrowings)", "borrowings"),
		("Gateway receivables", "gateway_receivables"),
		("Trade receivable (net)", "trade_receivable"),
		("  gross receivable", "receivable_gross"),
		("  customer advances", "customer_advances"),
		("Stock in hand", "stock_in_hand"),
		("Trade payable (net)", "trade_payable"),
		("  gross payable", "payable_gross"),
		("  supplier advances", "supplier_advances"),
		("Trade working capital (AR + stock − AP)", "trade_working_capital"),
		("Working capital incl. cash", "working_capital_with_cash"),
		("Working capital incl. cash, net of borrowings", "working_capital_net_of_borrowings"),
		("Internal debtor balance (reconciling item)", "internal_receivable"),
		("Internal creditor balance (reconciling item)", "internal_payable"),
	):
		_kv_inr(ws, label, k[key])
	ws.append([])
	_section(ws, "Days")
	for label, key in (("DSO", "dso"), ("DIO", "dio"), ("DPO", "dpo"), ("Cash conversion cycle", "ccc")):
		_kv_row(ws, label, k[key] if k[key] is not None else "n/a", _NUM_FMT_INT)
	ws.append([])

	_section(ws, "Bank and cash accounts")
	_header_row(ws, ["Account", "Type", "Balance (₹)", "Last posting"])
	for a in snap["bank"]["accounts"]:
		ws.append([a["account"], a["kind"]])
		_set_inr(ws.cell(row=ws.max_row, column=3), a["balance"])
		ws.cell(row=ws.max_row, column=4, value=a["last_posting_date"])
	ws.append([])

	for title, sec, top_key in (("Receivable ageing", snap["receivable"], "top_debtors"), ("Payable ageing", snap["payable"], "top_creditors")):
		_section(ws, title)
		for b in sec["aging"]["buckets"]:
			_kv_inr(ws, b["label"], b["amount"])
		_header_row(ws, ["Party", "Outstanding (₹)", "Age (days)", "Status"])
		for p in sec[top_key]:
			ws.append([p["party_name"]])
			_set_inr(ws.cell(row=ws.max_row, column=2), p["outstanding"])
			ws.cell(row=ws.max_row, column=3, value=p["age_days"])
			ws.cell(row=ws.max_row, column=4, value=p["status"])
		ws.append([])

	st = snap["stock"]
	_section(ws, "Stock")
	_kv_inr(ws, "Stock in hand (GL)", st["stock_in_hand"])
	_kv_inr(ws, "Bin total", st["bin_total"])
	_kv_inr(ws, "Bin − GL gap", st["bin_vs_gl_gap"])
	_kv_row(ws, "Negative bins", st["negative_bins"]["count"], _NUM_FMT_INT)
	_kv_row(ws, "Items below reorder level", st["reorder_count"], _NUM_FMT_INT)
	ws.append([])
	ws.append(["Notes", "Ageing from BNS Pure AR/AP reports, scaled to the GL gross balance. Internal accounts and parties excluded."])
	ws.cell(row=ws.max_row, column=1).font = _MUTED_FONT
	_autofit(ws, [48, 18, 12, 14])


# ── Small helpers ─────────────────────────────────────────────────────────────


def _header_row(ws, labels: list[str]) -> None:
	ws.append(labels)
	for cell in ws[ws.max_row]:
		cell.font = _HEADER_FONT
		cell.fill = _HEADER_FILL
		cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)


def _section(ws, label: str) -> None:
	ws.append([label])
	ws.cell(row=ws.max_row, column=1).font = _SECTION_FONT


def _kv_row(ws, key: str, value, fmt: str | None = None) -> None:
	ws.append([key, value])
	if fmt:
		ws.cell(row=ws.max_row, column=2).number_format = fmt


def _kv_inr(ws, key: str, value) -> None:
	ws.append([key])
	_set_inr(ws.cell(row=ws.max_row, column=2), value)


def _kv_pct(ws, key: str, value) -> None:
	ws.append([key, _frac(value)])
	ws.cell(row=ws.max_row, column=2).number_format = _NUM_FMT_PCT


def _write_provenance(ws, res: dict, note: str) -> None:
	ws.append([])
	ws.append(["Provenance"])
	ws.cell(row=ws.max_row, column=1).font = _SECTION_FONT
	ws.append(["Company", res.get("company", "—")])
	ws.append(["Period", res.get("period", {}).get("label", "—")])
	ws.append(["Tax basis", _basis_note(res)])
	ws.append(["Data refreshed", res.get("refreshed_at") or "—"])
	ws.append(["Exported", datetime.now(timezone.utc).isoformat(timespec="seconds")])
	ws.append(["Notes", note])
	ws.cell(row=ws.max_row, column=2).alignment = Alignment(wrap_text=True)
	for row in range(ws.max_row - 6, ws.max_row + 1):
		ws.cell(row=row, column=1).font = _MUTED_FONT


def _autofit(ws, widths: list[int]) -> None:
	for i, w in enumerate(widths, start=1):
		ws.column_dimensions[get_column_letter(i)].width = w


# ══════════════════════════════════════════════════════════════════════════════
# PDF REPORT — A4 portrait, green+beige theme matching the dashboard.
# ══════════════════════════════════════════════════════════════════════════════


@frappe.whitelist(allow_guest=False)
def download_mis_pdf(
	tax_mode: str = "excl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
	company: str | None = None,
) -> None:
	"""Render an A4 MIS report as PDF. Same data the dashboard uses — board-ready layout."""
	_require_mis_access()
	data = _gather(tax_mode, from_date, to_date, intent, company)
	html_doc = _build_pdf_html(data["overview"], data["assortment"], data["segments"], intent=intent, wc=data["wc"])
	pdf_bytes = get_pdf(
		html_doc,
		{
			"page-size": "A4",
			"margin-top": "14mm",
			"margin-bottom": "16mm",
			"margin-left": "14mm",
			"margin-right": "14mm",
			"encoding": "UTF-8",
			"print-media-type": None,
			"disable-smart-shrinking": None,
		},
	)
	frappe.response.update(
		{
			"filename": _filename(data["overview"], "pdf"),
			"filecontent": pdf_bytes,
			"type": "pdf",
			"display_content_as": "attachment",
		}
	)


def _accent(value, positive: str = "green") -> str:
	if not _finite(value):
		return "default"
	return positive if value >= 0 else "red"


def _build_pdf_html(overview: dict, assortment: dict, segments: dict, intent: str, wc: dict | None = None) -> str:
	"""Inline-CSS HTML → wkhtmltopdf. Keeping styles in-file avoids static-file path
	quirks on bench deploys; the tradeoff is verbosity we accept once per export."""
	kpi = overview["kpi"]
	now = datetime.now(timezone.utc).strftime("%d %b %Y · %H:%M UTC")
	intent_label = _INTENT_LABELS.get(intent, "All items")
	tax_label = "Revenue tax-inclusive" if overview["tax_mode"] == "incl" else "Revenue tax-exclusive"
	period = overview["period"]
	prior_ok = period["prior"]["available"]

	parts: list[str] = [
		"<!doctype html>",
		"<html><head><meta charset='utf-8'>",
		f"<title>MIS — {_esc(overview['company'])}</title>",
		_PDF_CSS,
		"</head><body>",
		"<section class='cover'>",
		"<div class='cover-eyebrow'>Consumer Business MIS</div>",
		f"<h1 class='cover-title'>{_esc(overview['company'])}</h1>",
		f"<div class='cover-period'>{_esc(period['label'])}</div>",
		"<div class='cover-tags'>",
		f"<span class='tag tag-green'>{_esc(tax_label)} · margins ex-tax</span>",
		"<span class='tag tag-blue'>Overview & P&amp;L: all items</span>",
		f"<span class='tag tag-amber'>SKU & segment pages: {_esc(intent_label)}</span>",
		"</div>",
		"<div class='cover-spacer'></div>",
		"<table class='cover-kpis'><tr>",
		_cover_kpi("Revenue", _inr(kpi["total_revenue"])),
		_cover_kpi("CM1 · GM", _pct(kpi["cm1_pct"]), accent=_accent(kpi["cm1_pct"])),
		_cover_kpi("CM2", _pct(kpi["cm2_pct"]), accent=_accent(kpi["cm2_pct"])),
		_cover_kpi("CM3", _pct(kpi["cm3_pct"]), accent=_accent(kpi["cm3_pct"], "amber")),
		_cover_kpi("EBITDA", _pct(kpi["ebitda_pct"]), accent=_accent(kpi["ebitda_pct"])),
		_cover_kpi("PAT", _pct(kpi["pat_pct"]), accent=_accent(kpi["pat_pct"])),
		"</tr></table>",
		_quality_note(overview.get("data_quality") or {}),
		f"<div class='cover-meta'>Generated {_esc(now)} · data refreshed {_esc(overview.get('refreshed_at') or '—')}</div>",
		"</section>",
	]

	def yoy(cur, prior) -> str:
		if not prior_ok:
			return "prior period incomplete"
		return _yoy_chip(cur, prior)

	parts.extend(
		[
			"<section class='page'>",
			_section_header("Revenue & Contribution Margin", f"{period['label']} · all items"),
			"<table class='kpi-grid'>",
			"<tr>",
			_kpi_cell("Total Revenue", _inr(kpi["total_revenue"]), yoy(kpi["total_revenue"], kpi["total_revenue_prior"])),
			_kpi_cell("B2C Revenue", _inr(kpi["b2c_revenue"]), yoy(kpi["b2c_revenue"], kpi["b2c_revenue_prior"])),
			_kpi_cell("B2B Revenue", _inr(kpi["b2b_revenue"]), yoy(kpi["b2b_revenue"], kpi["b2b_revenue_prior"])),
			"</tr>",
			"<tr>",
			_kpi_cell("Unclassified Revenue", _inr(kpi["unclassified_revenue"]), "no B2C/B2B intent"),
			_kpi_cell("Gross Profit (CM1)", _inr(kpi["gross_profit"]), f"{_pct(kpi['gross_margin_pct'])} · ex-tax", accent=_accent(kpi["gross_profit"])),
			_kpi_cell("Active SKUs", f"{int(kpi['active_skus']):,}", "stock items with sales", accent="blue"),
			"</tr>",
			"</table>",
			"<div class='sub-header'>Monthly revenue — B2C vs B2B</div>",
			_svg_monthly_chart(overview["monthly"]),
			"<div class='sub-header'>CM ladder — % of ex-tax revenue</div>",
			_svg_cm_ladder(kpi),
			_ladder_table(kpi),
			"</section>",
		]
	)

	parts.extend(
		[
			"<section class='page page-break'>",
			_section_header("P&L Waterfall", "Revenue → PAT · tax-exclusive · all items"),
			_pnl_table(overview),
			"</section>",
		]
	)

	parts.extend(
		[
			"<section class='page page-break'>",
			_section_header("Monthly Revenue", "₹ lakh · all items"),
			_monthly_table(overview["monthly"]),
			"<div class='spacer-16'></div>",
			_section_header("Revenue by Category", "top 10 · item group · all items"),
			_svg_category_bars(overview["categories"]),
			_category_table(overview["categories"]),
			"</section>",
		]
	)

	parts.extend(
		[
			"<section class='page page-break'>",
			_section_header("SKU Assortment — Top 50", f"{intent_label} · sorted by revenue · margins ex-tax"),
			_sku_table(assortment["rows"][:50]),
			_sku_totals(assortment["totals"]),
			_allocation_footer(assortment["allocation"]),
			"</section>",
		]
	)

	parts.extend(
		[
			"<section class='page page-break'>",
			_section_header("Customer Segments", f"{segments['totals']['segment_count']} segments · {intent_label}"),
			_svg_segment_bars(segments),
			_segment_summary_table(segments, prior_ok=segments["period"]["prior"]["available"]),
			_segment_top_customers(segments),
			"</section>",
		]
	)

	if wc:
		parts.extend(["<section class='page page-break'>", _wc_page(wc), "</section>"])

	parts.append("</body></html>")
	return "".join(parts)


# ── Small template helpers ────────────────────────────────────────────────────


def _section_header(title: str, sub: str) -> str:
	return (
		"<div class='section-head'>"
		f"<div class='section-title'>{_esc(title)}</div>"
		f"<div class='section-sub'>{_esc(sub)}</div>"
		"</div>"
	)


def _cover_kpi(label: str, value: str, accent: str = "default") -> str:
	return (
		"<td class='cover-kpi'>"
		f"<div class='cover-kpi-label'>{_esc(label)}</div>"
		f"<div class='cover-kpi-value accent-{accent}'>{_esc(value)}</div>"
		"</td>"
	)


def _kpi_cell(label: str, value: str, meta: str = "", accent: str = "default") -> str:
	return (
		"<td class='kpi-cell'>"
		f"<div class='kpi-label'>{_esc(label)}</div>"
		f"<div class='kpi-value accent-{accent}'>{_esc(value)}</div>"
		f"<div class='kpi-meta'>{_esc(meta)}</div>"
		"</td>"
	)


def _quality_note(q: dict) -> str:
	if not q.get("flagged_lines") and not q.get("warnings"):
		return ""
	bits = []
	if q.get("flagged_lines"):
		bits.append(
			f"{int(q['flagged_lines']):,} invoice lines with impossible stock cost ({_inr(q.get('flagged_cost'))}) "
			"are kept out of the item and segment split until reviewed. Totals use the GL and are unaffected."
		)
	for w in (q.get("warnings") or [])[:5]:
		bits.append(w.get("message", ""))
	return "<div class='footer-note'><b>Data issues:</b> " + " ".join(_esc(b) for b in bits) + "</div>"


def _ladder_table(kpi: dict) -> str:
	rows = [
		("CM1 · Gross Margin", "cm1", "revenue − cost of goods − direct costs"),
		("CM2 · Before marketing", "cm2", "− freight, packaging, txn, schemes"),
		("CM3 · After marketing", "cm3", "− marketing"),
		("EBITDA", "ebitda", "− salary, rent, utilities, admin, other net"),
		("EBIT", "ebit", "− D&A"),
		("PBT", "pbt", "− interest"),
		("PAT", "pat", "− income tax"),
	]
	body = "".join(
		f"<tr><td class='tier'>{_esc(label)}</td>"
		f"<td class='num'>{_inr(kpi[key])}</td>"
		f"<td class='num pct {'pos' if _finite(kpi[key + '_pct']) and kpi[key + '_pct'] >= 0 else 'neg'}'>{_pct(kpi[key + '_pct'])}</td>"
		f"<td class='hint'>{_esc(hint)}</td></tr>"
		for label, key, hint in rows
	)
	return (
		"<table class='ladder'>"
		"<thead><tr><th>Tier</th><th class='num'>₹</th><th class='num'>%</th><th>Definition</th></tr></thead>"
		f"<tbody>{body}</tbody></table>"
	)


def _pnl_table(overview: dict) -> str:
	steps = overview["pnl"]["overall"]
	body = "".join(
		f"<tr class='{'deduction' if s['kind'] == 'deduction' else 'tier'}'>"
		f"<td>{'&nbsp;&nbsp;' if s['kind'] == 'deduction' else ''}{_esc(s['label'])}</td>"
		f"<td class='num'>{_inr(s['amount'])}</td>"
		f"<td class='num pct'>{_pct(s['pct'])}</td>"
		f"<td class='hint'>{_esc(s.get('note') or '')}</td></tr>"
		for s in steps
	)
	kpi = overview["kpi"]
	check = (
		f"<div class='footer-note'>PAT {_inr(kpi['pat'])} = GL net profit {_inr(kpi['gl_net_profit'])} "
		f"(difference {_inr(kpi['pat_residual'])}).</div>"
	)
	return (
		"<table class='pnl'>"
		"<thead><tr><th>Line</th><th class='num'>₹</th><th class='num'>% Rev</th><th>Detail</th></tr></thead>"
		f"<tbody>{body}</tbody></table>" + check
	)


def _monthly_table(rows: list[dict]) -> str:
	if not rows:
		return "<div class='empty'>No monthly data in period.</div>"
	body = "".join(
		f"<tr><td>{_esc(r['month'])} {r['year']}{' (to date)' if r.get('partial') else ''}</td>"
		f"<td class='num'>{r['b2c']:,.2f}</td>"
		f"<td class='num'>{r['b2b']:,.2f}</td>"
		f"<td class='num'>{r['other']:,.2f}</td>"
		f"<td class='num tier'>{r['total']:,.2f}</td></tr>"
		for r in rows
	)
	return (
		"<table class='compact'>"
		"<thead><tr><th>Month</th><th class='num'>B2C</th><th class='num'>B2B</th><th class='num'>Unclassified</th><th class='num'>Total</th></tr></thead>"
		f"<tbody>{body}</tbody></table>"
	)


def _category_table(rows: list[dict]) -> str:
	total = sum(r["revenue"] for r in rows) or 1
	body = "".join(
		f"<tr><td>{_esc(r['category'])}</td>"
		f"<td class='num'>{int(r['sku_count']):,}</td>"
		f"<td class='num'>{r['revenue']:,.2f}</td>"
		f"<td class='num pct'>{_pct(r['revenue'] / total * 100)}</td></tr>"
		for r in rows
	)
	return (
		"<table class='compact'>"
		"<thead><tr><th>Category</th><th class='num'>SKUs</th><th class='num'>₹ L</th><th class='num'>% Mix</th></tr></thead>"
		f"<tbody>{body}</tbody></table>"
	)


def _cls(value, good: float) -> str:
	if not _finite(value):
		return ""
	return "pos" if value > good else "neg" if value < 0 else ""


def _sku_table(rows: list[dict]) -> str:
	if not rows:
		return "<div class='empty'>No SKU data in period.</div>"
	body = "".join(
		f"<tr><td class='num muted'>{i + 1}</td>"
		f"<td>{_esc(r['item_code'])}{' ⚠' if r.get('flagged_lines') else ''}<div class='hint truncate'>{_esc(r['item_name'])}</div></td>"
		f"<td>{_esc(r['item_group'])}</td>"
		f"<td class='num'>{int(r['qty']):,} {_esc(r.get('stock_uom') or '')}</td>"
		f"<td class='num'>{_inr(r['revenue'])}</td>"
		f"<td class='num {_cls(r['gm_pct'], 5)}'>{_pct(r['gm_pct'])}</td>"
		f"<td class='num {_cls(r['cm3_pct'], 2)}'>{_pct(r['cm3_pct'])}</td></tr>"
		for i, r in enumerate(rows)
	)
	return (
		"<table class='sku'>"
		"<thead><tr><th class='num'>#</th><th>SKU</th><th>Category</th><th class='num'>Units</th>"
		"<th class='num'>Revenue</th><th class='num'>GM %</th><th class='num'>CM3 %</th></tr></thead>"
		f"<tbody>{body}</tbody></table>"
	)


def _sku_totals(t: dict) -> str:
	return (
		"<div class='footer-note'>"
		f"Revenue ex-tax {_inr(t['revenue_excl'])} · cost on SKU lines {_inr(t['cogs'])} · "
		f"unallocated cost of goods {_inr(t['cogs_unallocated'])} · direct costs {_inr(t['direct_costs'])} · "
		f"gross profit {_inr(t['gp'])} ({_pct(t['gm_pct'])}). ⚠ = lines with impossible cost kept out of the split."
		"</div>"
	)


def _allocation_footer(alloc: dict) -> str:
	return (
		"<div class='footer-note'>"
		f"Allocations (% of ex-tax revenue): freight {alloc['freight_pct']:.2f}%, "
		f"packaging {alloc['packaging_pct']:.2f}%, "
		f"txn fees {alloc['commission_pct']:.2f}%, "
		f"scheme {alloc['scheme_pct']:.2f}%, "
		f"marketing {alloc['marketing_pct']:.2f}%. Basis: {_esc(alloc['basis'])}."
		"</div>"
	)


def _segment_summary_table(res: dict, prior_ok: bool = True) -> str:
	rows = res.get("segments", [])
	totals = res.get("totals", {})
	total_rev = totals.get("revenue") or 1
	body_rows: list[str] = []
	for s in rows:
		share = s["revenue"] / total_rev * 100
		yoy = _pct(s["yoy_pct"]) if (prior_ok and _finite(s["yoy_pct"])) else "n/a"
		body_rows.append(
			f"<tr><td>{_esc(s['segment'])}</td>"
			f"<td class='num'>{s['customers']:,}</td>"
			f"<td class='num'>{s['invoices']:,}</td>"
			f"<td class='num'>{_inr(s['revenue'])}</td>"
			f"<td class='num pct'>{_pct(share)}</td>"
			f"<td class='num pct {_cls(s['yoy_pct'], 0)}'>{_esc(yoy)}</td>"
			f"<td class='num {_cls(s['gm_pct'], 5)}'>{_pct(s['gm_pct'])}</td></tr>"
		)
	body_rows.append(
		f"<tr class='tier'><td>Total</td>"
		f"<td class='num'>{int(totals.get('customers', 0)):,}</td>"
		f"<td class='num'>{int(totals.get('invoices', 0)):,}</td>"
		f"<td class='num'>{_inr(totals.get('revenue', 0))}</td>"
		f"<td class='num pct'>100%</td><td class='num pct'>—</td>"
		f"<td class='num'>{_pct(totals.get('gm_pct'))}</td></tr>"
	)
	return (
		"<table class='compact'>"
		"<thead><tr><th>Segment</th><th class='num'>Cust</th><th class='num'>Inv</th>"
		"<th class='num'>Revenue</th><th class='num'>% Mix</th><th class='num'>YoY</th>"
		"<th class='num'>GM %</th></tr></thead>"
		f"<tbody>{''.join(body_rows)}</tbody></table>"
		f"<div class='footer-note'>Unallocated cost of goods {_inr(totals.get('cogs_unallocated'))} is not split by segment; "
		f"gross profit after it and direct costs: {_inr(totals.get('gp_after_unallocated'))}.</div>"
	)


def _segment_top_customers(res: dict) -> str:
	rows = res.get("segments", [])[:6]  # cap to avoid pagination overflow
	blocks: list[str] = []
	for s in rows:
		if not s["top_customers"]:
			continue
		seg_rev = s["revenue"] or 1
		customer_rows = "".join(
			f"<tr><td>{_esc(c['customer_name'])}</td>"
			f"<td class='num muted'>{int(c['invoices']):,}</td>"
			f"<td class='num'>{_inr(c['revenue'])}</td>"
			f"<td class='num pct'>{_pct(c['revenue'] / seg_rev * 100)}</td></tr>"
			for c in s["top_customers"][:3]
		)
		blocks.append(
			f"<div class='mini-card'>"
			f"<div class='mini-head'>{_esc(s['segment'])}"
			f"<span class='mini-meta'>· {_inr(s['revenue'])}</span></div>"
			f"<table class='mini-tbl'>{customer_rows}</table>"
			f"</div>"
		)
	if not blocks:
		return ""
	return "<div class='sub-header'>Top 3 customers per segment</div>" + "<div class='mini-grid'>" + "".join(blocks) + "</div>"


def _wc_page(snap: dict) -> str:
	o = snap["overview"]
	k = o["kpi"]

	def days(v) -> str:
		return f"{int(v)} days" if _finite(v) else "n/a"

	balances = [
		("Cash and bank", k["cash_and_bank"]),
		("Overdraft / cash credit", k["borrowings"]),
		("Gateway receivables", k["gateway_receivables"]),
		("Trade receivable (net)", k["trade_receivable"]),
		("  customer advances inside it", k["customer_advances"]),
		("Stock in hand", k["stock_in_hand"]),
		("Trade payable (net)", k["trade_payable"]),
		("  supplier advances inside it", k["supplier_advances"]),
		("Trade working capital (AR + stock − AP)", k["trade_working_capital"]),
		("  incl. cash", k["working_capital_with_cash"]),
		("  incl. cash, net of borrowings", k["working_capital_net_of_borrowings"]),
		("Internal debtor (reconciling item)", k["internal_receivable"]),
		("Internal creditor (reconciling item)", k["internal_payable"]),
	]
	body = "".join(
		f"<tr class='{'deduction' if label.startswith('  ') else ''}'><td>{_esc(label)}</td><td class='num {'neg' if _finite(v) and v < 0 else ''}'>{_inr(v)}</td></tr>"
		for label, v in balances
	)
	ratios = (
		f"<div class='footer-note'>DSO {days(k['dso'])} · DIO {days(k['dio'])} · DPO {days(k['dpo'])} · "
		f"cash conversion cycle {days(k['ccc'])}. Ageing from BNS Pure AR/AP, scaled to the GL gross balance.</div>"
	)

	def ageing(title: str, sec: dict) -> str:
		rows = "".join(
			f"<tr><td>{_esc(b['label'])}</td><td class='num'>{_inr(b['amount'])}</td><td class='num pct'>{_pct(b['pct'], 1)}</td></tr>"
			for b in sec["aging"]["buckets"]
		)
		return (
			f"<div class='sub-header'>{_esc(title)} — gross {_inr(sec['gross'])}, advances {_inr(sec['advances'])}</div>"
			f"<table class='compact'><thead><tr><th>Bucket</th><th class='num'>₹</th><th class='num'>%</th></tr></thead><tbody>{rows}</tbody></table>"
		)

	return (
		_section_header("Working Capital", f"As of {o['as_of']} · all balances from the GL")
		+ f"<table class='compact'><thead><tr><th>Balance</th><th class='num'>₹</th></tr></thead><tbody>{body}</tbody></table>"
		+ ratios
		+ ageing("Receivable ageing", snap["receivable"])
		+ ageing("Payable ageing", snap["payable"])
	)


def _yoy_chip(cur: float, prior: float) -> str:
	if not prior:
		return ""
	pct = (cur - prior) / abs(prior) * 100
	if round(pct) == 0:
		return "0% YoY"
	sign = "↑" if pct > 0 else "↓"
	return f"{sign}{abs(pct):.0f}% YoY"


def _esc(value) -> str:
	return _html.escape(str(value), quote=True) if value is not None else ""


_PDF_CSS = """
<style>
@page { size: A4; margin: 14mm 14mm 16mm 14mm; }
* { box-sizing: border-box; }
body {
	font-family: "Helvetica", "Arial", sans-serif;
	color: #1a1810;
	background: #ffffff;
	font-size: 10.5px;
	line-height: 1.45;
	margin: 0;
	padding: 0;
}
section { page-break-inside: avoid; }
.page { padding: 0; }
.page-break { page-break-before: always; }
.spacer-16 { height: 16px; }

/* Cover */
.cover {
	page-break-after: always;
	padding: 32mm 4mm 0 4mm;
	background: #f4f1e8;
	min-height: 240mm;
	border-left: 4px solid #1F5F33;
}
.cover-eyebrow {
	font-size: 10px;
	letter-spacing: 0.2em;
	text-transform: uppercase;
	color: #1F5F33;
	font-weight: 700;
	margin-bottom: 6mm;
}
.cover-title {
	font-family: "Times New Roman", serif;
	font-size: 32pt;
	line-height: 1.1;
	margin: 0 0 5mm 0;
	color: #1a1810;
}
.cover-period { font-size: 11.5px; color: #574f3e; font-weight: 600; }
.cover-tags { margin-top: 4mm; }
.tag {
	display: inline-block;
	font-size: 9.5px;
	font-weight: 600;
	padding: 3px 10px;
	border-radius: 10px;
	margin-right: 4px;
}
.tag-green { background: #dfeed9; color: #1F5F33; }
.tag-amber { background: #f8e7c9; color: #96560f; }
.tag-blue { background: #dae5f1; color: #2c4e80; }
.cover-spacer { height: 20mm; }
.cover-kpis {
	width: 100%;
	border-collapse: separate;
	border-spacing: 6px 0;
	margin-top: 12mm;
}
.cover-kpi {
	width: 16.6%;
	background: #ffffff;
	border: 1px solid rgba(40,30,15,0.12);
	padding: 5mm 4mm;
	border-radius: 6px;
	vertical-align: top;
}
.cover-kpi-label {
	font-size: 8.5px;
	letter-spacing: 0.1em;
	text-transform: uppercase;
	color: #7a6f5d;
	font-weight: 600;
	margin-bottom: 3mm;
}
.cover-kpi-value {
	font-size: 16pt;
	font-weight: 700;
	color: #1a1810;
	letter-spacing: -0.02em;
}
.cover-meta {
	/* Keep this in the cover's flow — ``position: absolute`` escaped wkhtmltopdf's
	 * page boundaries and repeated the timestamp on every subsequent page. */
	margin-top: 38mm;
	font-size: 9px;
	color: #9e9382;
}
.accent-green { color: #1F5F33; }
.accent-amber { color: #96560f; }
.accent-red { color: #7A1F1F; }
.accent-blue { color: #2c4e80; }

/* Section header */
.section-head {
	display: block;
	border-bottom: 1px solid rgba(40,30,15,0.15);
	padding-bottom: 3mm;
	margin-bottom: 4mm;
}
.section-title {
	font-family: "Times New Roman", serif;
	font-size: 18pt;
	font-weight: 700;
	color: #1a1810;
	line-height: 1.1;
}
.section-sub {
	font-size: 10px;
	color: #7a6f5d;
	margin-top: 1mm;
	font-weight: 600;
}
.sub-header {
	font-size: 10.5px;
	font-weight: 700;
	color: #1a1810;
	margin: 6mm 0 2mm 0;
	padding-bottom: 1mm;
	border-bottom: 1px solid rgba(40,30,15,0.08);
}

/* KPI grid */
.kpi-grid {
	width: 100%;
	border-collapse: separate;
	border-spacing: 4px;
}
.kpi-cell {
	width: 33.3%;
	background: #faf7f0;
	border: 1px solid rgba(40,30,15,0.12);
	padding: 3mm;
	vertical-align: top;
	border-radius: 4px;
}
.kpi-label {
	font-size: 8.5px;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: #7a6f5d;
	font-weight: 600;
	margin-bottom: 1mm;
}
.kpi-value {
	font-size: 13pt;
	font-weight: 700;
	color: #1a1810;
	line-height: 1.1;
}
.kpi-meta {
	font-size: 9px;
	color: #574f3e;
	margin-top: 1mm;
}

/* Tables */
table.ladder, table.pnl, table.compact, table.sku, table.mini-tbl {
	width: 100%;
	border-collapse: collapse;
	font-size: 9.5px;
}
table.ladder th, table.pnl th, table.compact th, table.sku th {
	text-align: left;
	background: #1F5F33;
	color: #ffffff;
	font-weight: 600;
	font-size: 9px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	padding: 4px 6px;
}
table.ladder td, table.pnl td, table.compact td, table.sku td {
	padding: 3px 6px;
	border-bottom: 1px solid rgba(40,30,15,0.08);
	color: #1a1810;
}
table.ladder tr.tier td, table.pnl tr.tier td, .tier {
	background: #ebe6d9;
	font-weight: 700;
}
table.pnl tr.deduction td { color: #574f3e; }
.num { text-align: right; }
.pct { font-variant-numeric: tabular-nums; }
.pos { color: #1F5F33; }
.neg { color: #7A1F1F; }
.muted { color: #7a6f5d; }
.hint { color: #7a6f5d; font-size: 9px; }
.truncate {
	max-width: 58mm;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.footer-note {
	margin-top: 3mm;
	font-size: 9px;
	color: #7a6f5d;
	font-style: italic;
}
.empty {
	padding: 8mm;
	text-align: center;
	color: #9e9382;
	font-size: 10px;
	font-style: italic;
}

/* Server-side SVG charts. Inline width 100% so wkhtmltopdf scales them to the
 * printable width while keeping the viewBox aspect ratio. Small top margin
 * separates chart from the section sub-header. */
svg.chart {
	display: block;
	margin: 2mm 0 4mm 0;
	max-width: 100%;
}

/* Mini cards for segments */
.mini-grid {
	display: block;
}
.mini-card {
	display: inline-block;
	width: 48%;
	margin: 1% 1% 3mm 0;
	border: 1px solid rgba(40,30,15,0.12);
	background: #ffffff;
	border-radius: 4px;
	padding: 3mm;
	vertical-align: top;
	page-break-inside: avoid;
}
.mini-head {
	font-weight: 700;
	font-size: 10px;
	color: #1a1810;
	margin-bottom: 2mm;
	padding-bottom: 1mm;
	border-bottom: 1px solid rgba(40,30,15,0.08);
}
.mini-meta {
	font-weight: 400;
	font-size: 9px;
	color: #7a6f5d;
	margin-left: 4px;
}
table.mini-tbl td { border-bottom: none; padding: 2px 4px; font-size: 9px; }
</style>
"""


# ── Server-side PNG charts (Pillow) ───────────────────────────────────────────
# wkhtmltopdf 0.12 silently drops inline SVG, so we rasterize to PNG server-side
# and embed as data URLs. Colours mirror the dashboard so the PDF stays visually
# consistent with the on-screen Recharts. Pillow ships with Frappe — no new dep.

_CH_GREEN = (31, 95, 51)
_CH_GREEN_LT = (31, 95, 51, 58)  # 22% alpha
_CH_AMBER = (150, 86, 15)
_CH_RED = (122, 31, 31)
_CH_BLUE = (44, 78, 128)
_CH_MUTED = (122, 111, 93)
_CH_GRID = (40, 30, 15, 20)
_CH_TEXT = (26, 24, 16)
_CH_WHITE = (255, 255, 255)
_CH_SURFACE = (250, 247, 240)

# 2× render resolution → downscale in the PDF via CSS width. Keeps charts crisp
# in print without blowing up file size.
_SCALE = 2


def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
	paths = [
		"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
		if bold
		else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
		"/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"
		if bold
		else "/usr/share/fonts/dejavu/DejaVuSans.ttf",
	]
	for p in paths:
		if os.path.exists(p):
			return ImageFont.truetype(p, size * _SCALE)
	return ImageFont.load_default()


def _png_data_url(img: Image.Image) -> str:
	buf = io.BytesIO()
	img.save(buf, format="PNG", optimize=True)
	return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def _img_tag(img: Image.Image, width_px: int) -> str:
	"""Render at 2× internally, display at 1× in the PDF so print output stays sharp."""
	return f'<img class="chart" src="{_png_data_url(img)}" style="width:{width_px}px;max-width:100%;">'


def _text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> float:
	if hasattr(draw, "textbbox"):
		bbox = draw.textbbox((0, 0), text, font=font)
		return bbox[2] - bbox[0]
	return draw.textlength(text, font=font)




def _svg_monthly_chart(rows: list[dict], width: int = 720, height: int = 200) -> str:
	"""Monthly B2C area + B2B line + Total line, rendered to PNG for wkhtmltopdf."""
	if not rows:
		return "<div class='empty'>No monthly data.</div>"

	W, H = width * _SCALE, height * _SCALE
	img = Image.new("RGB", (W, H), _CH_WHITE)
	draw = ImageDraw.Draw(img, "RGBA")
	f_axis = _load_font(9)
	f_legend = _load_font(9)

	pad_l, pad_r, pad_t, pad_b = 44 * _SCALE, 12 * _SCALE, 8 * _SCALE, 32 * _SCALE
	chart_w = W - pad_l - pad_r
	chart_h = H - pad_t - pad_b
	n = len(rows)
	step = chart_w / max(n - 1, 1)
	max_val = max((r.get("total") or 0) for r in rows) or 1

	def xy(i: int, v: float) -> tuple[float, float]:
		x = pad_l + i * step
		y = pad_t + chart_h - (v / max_val) * chart_h
		return x, y

	# Grid + Y labels at 0 / 33% / 66% / 100%
	for frac, label in [(0, "0"), (0.33, f"{max_val * 0.33:.0f}"), (0.66, f"{max_val * 0.66:.0f}"), (1, f"{max_val:.0f}L")]:
		y = pad_t + chart_h - frac * chart_h
		draw.line([(pad_l, y), (pad_l + chart_w, y)], fill=_CH_GRID, width=1)
		draw.text((pad_l - 6 * _SCALE, y - 5 * _SCALE), label, font=f_axis, fill=_CH_MUTED, anchor="rm")

	# B2C area (fill + outline)
	b2c_pts = [xy(i, r.get("b2c") or 0) for i, r in enumerate(rows)]
	area_pts = b2c_pts + [(pad_l + chart_w, pad_t + chart_h), (pad_l, pad_t + chart_h)]
	draw.polygon(area_pts, fill=_CH_GREEN_LT)
	if len(b2c_pts) > 1:
		draw.line(b2c_pts, fill=_CH_GREEN, width=2 * _SCALE, joint="curve")

	# B2B line
	b2b_pts = [xy(i, r.get("b2b") or 0) for i, r in enumerate(rows)]
	if len(b2b_pts) > 1:
		draw.line(b2b_pts, fill=_CH_AMBER, width=2 * _SCALE, joint="curve")

	# Total dashed
	total_pts = [xy(i, r.get("total") or 0) for i, r in enumerate(rows)]
	for a, b in zip(total_pts, total_pts[1:]):
		# manual dashed — Pillow has no native dash pattern
		dx, dy = b[0] - a[0], b[1] - a[1]
		length = (dx * dx + dy * dy) ** 0.5 or 1
		ux, uy = dx / length, dy / length
		dash = 6 * _SCALE
		gap = 4 * _SCALE
		d = 0.0
		while d < length:
			x1 = a[0] + ux * d
			y1 = a[1] + uy * d
			x2 = a[0] + ux * min(d + dash, length)
			y2 = a[1] + uy * min(d + dash, length)
			draw.line([(x1, y1), (x2, y2)], fill=_CH_TEXT, width=1 * _SCALE)
			d += dash + gap

	# X-axis month labels
	tick = 1 if n <= 8 else 2
	for i, r in enumerate(rows):
		if i % tick != 0 and i != n - 1:
			continue
		x = pad_l + i * step
		draw.text((x, pad_t + chart_h + 6 * _SCALE), str(r.get("month", "")), font=f_axis, fill=_CH_MUTED, anchor="mt")

	# Legend
	lx = pad_l
	ly = H - 12 * _SCALE
	draw.rectangle([lx, ly, lx + 10 * _SCALE, ly + 3 * _SCALE], fill=_CH_GREEN)
	draw.text((lx + 14 * _SCALE, ly), "B2C", font=f_legend, fill=_CH_MUTED, anchor="lm")
	lx += 46 * _SCALE
	draw.rectangle([lx, ly, lx + 10 * _SCALE, ly + 3 * _SCALE], fill=_CH_AMBER)
	draw.text((lx + 14 * _SCALE, ly), "B2B", font=f_legend, fill=_CH_MUTED, anchor="lm")
	lx += 46 * _SCALE
	draw.rectangle([lx, ly, lx + 10 * _SCALE, ly + 1 * _SCALE], fill=_CH_TEXT)
	draw.text((lx + 14 * _SCALE, ly), "Total", font=f_legend, fill=_CH_MUTED, anchor="lm")

	return _img_tag(img, width)


def _svg_cm_ladder(kpi: dict, width: int = 720, height: int = 200) -> str:
	"""CM ladder bars: tier %-of-revenue, centred on zero."""
	# Null margins (revenue below the floor) draw as an empty slot labelled n/a; an
	# absurd margin is clipped to ±100% so one bad tier can't flatten the others.
	tiers = [
		(label, kpi[f"{key}_pct"])
		for label, key in (
			("CM1", "cm1"),
			("CM2", "cm2"),
			("CM3", "cm3"),
			("EBITDA", "ebitda"),
			("EBIT", "ebit"),
			("PBT", "pbt"),
			("PAT", "pat"),
		)
	]
	W, H = width * _SCALE, height * _SCALE
	img = Image.new("RGB", (W, H), _CH_WHITE)
	draw = ImageDraw.Draw(img)
	f_axis = _load_font(9)
	f_label = _load_font(9, bold=True)
	f_value = _load_font(9, bold=True)

	pad_l, pad_r, pad_t, pad_b = 36 * _SCALE, 12 * _SCALE, 16 * _SCALE, 30 * _SCALE
	chart_w = W - pad_l - pad_r
	chart_h = H - pad_t - pad_b
	y_zero = pad_t + chart_h / 2

	max_abs = max((min(abs(v), 100.0) for _, v in tiers if _finite(v)), default=0) or 1
	span = max_abs * 1.15

	def y_for(v: float) -> float:
		return y_zero - (v / span) * (chart_h / 2)

	# Gridlines + labels
	for v, label in [(span, f"{span:.1f}%"), (0, "0"), (-span, f"-{span:.1f}%")]:
		y = y_for(v)
		col = (60, 45, 25, 110) if v == 0 else _CH_GRID
		draw.line([(pad_l, y), (pad_l + chart_w, y)], fill=col, width=1)
		draw.text((pad_l - 6 * _SCALE, y - 5 * _SCALE), label, font=f_axis, fill=_CH_MUTED, anchor="rm")

	n = len(tiers)
	bar_w = chart_w / n * 0.58
	gap = chart_w / n - bar_w

	for i, (label, raw_pct) in enumerate(tiers):
		bx = pad_l + i * (bar_w + gap) + gap / 2
		if not _finite(raw_pct):
			draw.text((bx + bar_w / 2, y_zero - 4 * _SCALE), "n/a", font=f_value, fill=_CH_MUTED, anchor="mb")
			draw.text((bx + bar_w / 2, pad_t + chart_h + 10 * _SCALE), label, font=f_label, fill=_CH_MUTED, anchor="mt")
			continue
		pct = max(min(raw_pct, 100.0), -100.0)
		if pct >= 0:
			by = y_for(pct)
			bh = y_zero - by
		else:
			by = y_zero
			bh = y_for(pct) - y_zero
		fill = _CH_GREEN if pct >= 0 else _CH_RED
		draw.rectangle([bx, by, bx + bar_w, by + max(bh, 1.5 * _SCALE)], fill=fill)

		# Value label — above positive bars, below negative
		if pct >= 0:
			ty = by - 4 * _SCALE
			anchor = "mb"
		else:
			ty = by + bh + 4 * _SCALE
			anchor = "mt"
		draw.text((bx + bar_w / 2, ty), _pct(raw_pct), font=f_value, fill=_CH_TEXT, anchor=anchor)

		# X-axis tier label
		draw.text(
			(bx + bar_w / 2, pad_t + chart_h + 10 * _SCALE),
			label,
			font=f_label,
			fill=_CH_MUTED,
			anchor="mt",
		)

	return _img_tag(img, width)


def _svg_category_bars(rows: list[dict], width: int = 720) -> str:
	"""Horizontal bars for top categories, category name on the left."""
	if not rows:
		return ""
	top = rows[:10]
	max_val = max(r["revenue"] for r in top) or 1

	row_h = 18
	pad_l, pad_r, pad_t = 120, 80, 8
	height = len(top) * row_h + pad_t + 12
	W, H = width * _SCALE, height * _SCALE

	img = Image.new("RGB", (W, H), _CH_WHITE)
	draw = ImageDraw.Draw(img)
	f_label = _load_font(10)
	f_value = _load_font(9, bold=True)

	chart_w = W - (pad_l + pad_r) * _SCALE

	for i, r in enumerate(top):
		y = (pad_t + i * row_h + row_h / 2) * _SCALE
		bar_len = (r["revenue"] / max_val) * chart_w
		# category label (right-aligned)
		draw.text(((pad_l - 6) * _SCALE, y), _truncate(r["category"], 22), font=f_label, fill=_CH_TEXT, anchor="rm")
		# bar
		draw.rectangle(
			[pad_l * _SCALE, y - 7 * _SCALE, pad_l * _SCALE + max(bar_len, 2), y + 7 * _SCALE],
			fill=_CH_GREEN,
		)
		# value
		draw.text(
			(pad_l * _SCALE + bar_len + 4 * _SCALE, y),
			_inr(r["revenue"] * 1_00_000),
			font=f_value,
			fill=_CH_TEXT,
			anchor="lm",
		)

	return _img_tag(img, width)


def _svg_segment_bars(res: dict, width: int = 720) -> str:
	"""Segment revenue bars, with % of total on the right. (unassigned) coloured amber."""
	rows = res.get("segments", [])
	if not rows:
		return ""
	top = rows[:10]
	total = res["totals"].get("revenue") or 1
	max_val = max(s["revenue"] for s in top) or 1

	row_h = 19
	pad_l, pad_r, pad_t = 140, 110, 8
	height = len(top) * row_h + pad_t + 12
	W, H = width * _SCALE, height * _SCALE

	img = Image.new("RGB", (W, H), _CH_WHITE)
	draw = ImageDraw.Draw(img)
	f_label = _load_font(10)
	f_value = _load_font(9, bold=True)
	f_share = _load_font(9)

	chart_w = W - (pad_l + pad_r) * _SCALE

	for i, s in enumerate(top):
		y = (pad_t + i * row_h + row_h / 2) * _SCALE
		bar_len = (s["revenue"] / max_val) * chart_w
		share = s["revenue"] / total * 100
		is_un = s["segment"] == "(unassigned)"
		fill = _CH_AMBER if is_un else _CH_BLUE
		draw.text(
			((pad_l - 6) * _SCALE, y),
			_truncate(s["segment"], 20),
			font=f_label,
			fill=_CH_TEXT,
			anchor="rm",
		)
		draw.rectangle(
			[pad_l * _SCALE, y - 7 * _SCALE, pad_l * _SCALE + max(bar_len, 2), y + 7 * _SCALE],
			fill=fill,
		)
		value_text = _inr(s["revenue"])
		draw.text(
			(pad_l * _SCALE + bar_len + 4 * _SCALE, y),
			value_text,
			font=f_value,
			fill=_CH_TEXT,
			anchor="lm",
		)
		# share in muted grey to the right of the value
		value_w = _text_width(draw, value_text, f_value)
		draw.text(
			(pad_l * _SCALE + bar_len + 4 * _SCALE + value_w + 6 * _SCALE, y),
			f"· {share:.1f}%",
			font=f_share,
			fill=_CH_MUTED,
			anchor="lm",
		)

	return _img_tag(img, width)


def _truncate(text: str, max_chars: int) -> str:
	return text if len(text) <= max_chars else text[: max_chars - 1] + "…"
