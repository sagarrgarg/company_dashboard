"""One-shot Excel export of every MIS dashboard page.

Delivers a single .xlsx with one sheet per tab:

  - Overview KPIs
  - Monthly Revenue
  - Revenue by Category
  - P&L Waterfall
  - SKU Assortment
  - Customer Segments

Each sheet is self-contained: headers, number formats, and a trailing "Provenance"
row capturing period + tax-mode + allocation basis — so a downloaded pack can be
audited standalone later without opening the dashboard.
"""

from __future__ import annotations

import io
from datetime import datetime, timezone

import frappe
from frappe import _
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from company_dashboard.api.mis import (
	_require_mis_access,
	get_customer_segments,
	get_overview,
	get_sku_assortment,
)

# Green header band matching the dashboard's brand — WCAG-AA against white text.
_HEADER_FILL = PatternFill("solid", fgColor="1F5F33")
_HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
_SECTION_FONT = Font(bold=True, color="1A1810", size=12)
_MUTED_FONT = Font(color="7A6F5D", size=10, italic=True)
_NUM_FMT_INR = '"₹"#,##0'
_NUM_FMT_PCT = "0.00%"
_NUM_FMT_INT = "#,##0"


@frappe.whitelist(allow_guest=False)
def download_mis_workbook(
	tax_mode: str = "incl",
	from_date: str | None = None,
	to_date: str | None = None,
	intent: str = "all",
) -> None:
	"""Whitelisted endpoint — streams the workbook back to the browser as a download.

	Frappe's ``frappe.response`` hook handles the file mechanics: we set ``filename``,
	``filecontent``, and ``type="binary"`` and Frappe returns the right Content-Type +
	Content-Disposition headers automatically.
	"""
	_require_mis_access()

	# Gather all four pages' data with the caller's filter settings. Each call does
	# its own access check, tax-mode validation, and period resolution.
	overview = get_overview(tax_mode=tax_mode, from_date=from_date, to_date=to_date)
	assortment = get_sku_assortment(
		tax_mode=tax_mode, from_date=from_date, to_date=to_date, intent=intent
	)
	segments = get_customer_segments(
		tax_mode=tax_mode, from_date=from_date, to_date=to_date, intent=intent
	)

	wb = Workbook()
	# Drop the default blank sheet.
	default = wb.active
	wb.remove(default)

	_write_overview_sheet(wb, overview)
	_write_monthly_sheet(wb, overview)
	_write_categories_sheet(wb, overview)
	_write_pnl_sheet(wb, overview)
	_write_assortment_sheet(wb, assortment)
	_write_segments_sheet(wb, segments)

	buf = io.BytesIO()
	wb.save(buf)
	buf.seek(0)

	period_label = overview["period"]["label"].replace(" ", "_")
	filename = f"MIS_{overview['company'].replace(' ', '_')}_{period_label}.xlsx"
	frappe.response.update(
		{
			"filename": filename,
			"filecontent": buf.getvalue(),
			"type": "binary",
			"display_content_as": "attachment",
		}
	)


# ── Sheet writers ─────────────────────────────────────────────────────────────


def _write_overview_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Overview KPIs")
	kpi = res["kpi"]
	ws.append(["MIS Overview", res["company"]])
	ws["A1"].font = _SECTION_FONT
	ws.append([res["period"]["label"], res["tax_mode"].upper()])
	ws["A2"].font = _MUTED_FONT
	ws.append([])

	_section(ws, "Revenue")
	_kv_row(ws, "Total Revenue", kpi["total_revenue"], _NUM_FMT_INR)
	_kv_row(ws, "Total Revenue (prior)", kpi["total_revenue_prior"], _NUM_FMT_INR)
	_kv_row(ws, "B2C Revenue", kpi["b2c_revenue"], _NUM_FMT_INR)
	_kv_row(ws, "B2B Revenue", kpi["b2b_revenue"], _NUM_FMT_INR)
	_kv_row(ws, "Unclassified Revenue", kpi["unclassified_revenue"], _NUM_FMT_INR)
	ws.append([])

	_section(ws, "Gross Margin")
	_kv_row(ws, "Gross Profit", kpi["gross_profit"], _NUM_FMT_INR)
	_kv_row(ws, "Gross Margin %", kpi["gross_margin_pct"] / 100, _NUM_FMT_PCT)
	_kv_row(ws, "Valuation Coverage %", kpi["gross_margin_coverage_pct"] / 100, _NUM_FMT_PCT)
	_kv_row(ws, "B2C GM %", kpi["b2c_gross_margin_pct"] / 100, _NUM_FMT_PCT)
	_kv_row(ws, "B2B GM %", kpi["b2b_gross_margin_pct"] / 100, _NUM_FMT_PCT)
	ws.append([])

	_section(ws, "Contribution Margin ladder")
	for label, abs_val, pct_val in [
		("CM1 (Gross Margin)", kpi["cm1"], kpi["cm1_pct"]),
		("CM2 (before marketing)", kpi["cm2"], kpi["cm2_pct"]),
		("CM3 (after marketing)", kpi["cm3"], kpi["cm3_pct"]),
		("EBITDA", kpi["ebitda"], kpi["ebitda_pct"]),
		("EBIT", kpi["ebit"], kpi["ebit_pct"]),
		("PBT", kpi["pbt"], kpi["pbt_pct"]),
		("PAT", kpi["pat"], kpi["pat_pct"]),
	]:
		row = ws.max_row + 1
		ws.cell(row=row, column=1, value=label)
		ws.cell(row=row, column=2, value=abs_val).number_format = _NUM_FMT_INR
		ws.cell(row=row, column=3, value=pct_val / 100).number_format = _NUM_FMT_PCT
	ws.append([])

	_section(ws, "Activity")
	_kv_row(ws, "Active SKUs", kpi["active_skus"], _NUM_FMT_INT)
	_kv_row(ws, "Average MRP/SKU", kpi["avg_mrp"], _NUM_FMT_INR)
	ws.append([])

	_write_provenance(ws, res, "CM1 = Gross Margin · CM2 = −freight/pkg/txn/schemes · CM3 = CM2 − marketing")
	_autofit(ws, [36, 18, 18])


def _write_monthly_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Monthly Revenue")
	rows = res.get("monthly", [])
	_header_row(ws, ["Month", "Year", "B2C (₹L)", "B2B (₹L)", "Other (₹L)", "Total (₹L)"])
	for r in rows:
		ws.append([r["month"], r["year"], r["b2c"], r["b2b"], r["other"], r["total"]])
	# Totals
	last = ws.max_row
	if rows:
		total_row = last + 1
		ws.cell(row=total_row, column=1, value="Total").font = _SECTION_FONT
		for col in (3, 4, 5, 6):
			letter = get_column_letter(col)
			ws.cell(
				row=total_row, column=col, value=f"=SUM({letter}2:{letter}{last})"
			).font = _SECTION_FONT
	_write_provenance(ws, res, "Revenue in ₹ lakhs. 'Other' = items without a B2C/B2B custom_sales_intent.")
	_autofit(ws, [10, 8, 12, 12, 12, 12])


def _write_categories_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Revenue by Category")
	rows = res.get("categories", [])
	_header_row(ws, ["Category", "SKU Count", "Revenue (₹L)", "% of Shown"])
	total = sum(r["revenue"] for r in rows) or 1
	for r in rows:
		share = r["revenue"] / total
		ws.append([r["category"], r["sku_count"], r["revenue"], share])
		ws.cell(row=ws.max_row, column=4).number_format = _NUM_FMT_PCT
	total_row = ws.max_row + 1
	ws.cell(row=total_row, column=1, value="Total").font = _SECTION_FONT
	ws.cell(row=total_row, column=2, value=sum(r["sku_count"] for r in rows)).font = _SECTION_FONT
	ws.cell(row=total_row, column=3, value=total).font = _SECTION_FONT
	ws.cell(row=total_row, column=4, value=1).number_format = _NUM_FMT_PCT
	_write_provenance(ws, res, "Top 10 Item Groups by revenue; rest collapsed into 'Other'.")
	_autofit(ws, [28, 12, 14, 12])


def _write_pnl_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("P&L Waterfall")
	kpi = res["kpi"]
	c2 = res["cm2_inputs"]
	c3 = res["cm3_inputs"]
	li = res["ladder_inputs"]
	rev = kpi["total_revenue"] or 1

	_header_row(ws, ["Line Item", "Amount (₹)", "% of Revenue", "Detail"])

	def line(label: str, amount: float, is_tier: bool = False, detail: str = "") -> None:
		row = ws.max_row + 1
		ws.cell(row=row, column=1, value=label)
		ws.cell(row=row, column=2, value=amount).number_format = _NUM_FMT_INR
		ws.cell(row=row, column=3, value=amount / rev).number_format = _NUM_FMT_PCT
		ws.cell(row=row, column=4, value=detail)
		if is_tier:
			for col in range(1, 5):
				ws.cell(row=row, column=col).font = Font(bold=True)

	line("Gross Revenue", kpi["total_revenue"], is_tier=True)
	line("    COGS (incoming_rate × qty)", -(kpi["total_revenue"] - kpi["gross_profit"]), detail="includes primary packaging via BOM")
	line("CM1 · Gross Margin", kpi["cm1"], is_tier=True)

	line("    Outbound Freight", -c2["freight_total"], detail=f"{len(c2['freight_accounts'])} accounts")
	line("    Packaging Overhead", -c2["packaging_total"], detail=f"{len(c2['packaging_accounts'])} accounts")
	line("    Transaction Fees & Commissions", -c2["commission_total"], detail=f"{len(c2['commission_accounts'])} accounts")
	line("    Trade Schemes", -c2["scheme_total"], detail=f"{len(c2['scheme_accounts'])} accounts")
	line("CM2 · Before marketing", kpi["cm2"], is_tier=True)

	line("    Marketing", -c3["marketing_total"], detail=f"{len(c3['marketing_accounts'])} accounts")
	line("CM3 · After marketing", kpi["cm3"], is_tier=True)

	line("    Salary & Payroll", -li["salary_total"], detail=f"{len(li['salary_accounts'])} accounts")
	line("    Rent & Lease", -li["rent_total"], detail=f"{len(li['rent_accounts'])} accounts")
	line("    Utilities & Communications", -li["utility_total"], detail=f"{len(li['utility_accounts'])} accounts")
	line("    Admin & General Overhead", -li["admin_total"], detail=f"{len(li['admin_accounts'])} accounts")
	line("EBITDA", kpi["ebitda"], is_tier=True)

	line("    Depreciation & Amortization", -li["da_total"], detail=f"{len(li['da_accounts'])} accounts")
	line("EBIT", kpi["ebit"], is_tier=True)

	line("    Interest & Finance Cost", -li["interest_total"], detail=f"{len(li['interest_accounts'])} accounts")
	line("PBT", kpi["pbt"], is_tier=True)

	line("    Income Tax Expense", -li["tax_total"], detail=f"{len(li['tax_accounts'])} accounts")
	line("PAT", kpi["pat"], is_tier=True)

	ws.append([])
	_write_provenance(ws, res, "Line-by-line P&L from Sales Invoice + GL. All CM tiers computed tax-exclusive.")
	_autofit(ws, [38, 16, 14, 40])


def _write_assortment_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("SKU Assortment")
	rows = res.get("rows", [])
	month_keys = res.get("month_keys", [])
	base_cols = [
		"#", "SKU", "Item Name", "Item Group", "Intent",
		"Units", "Revenue (₹)", "COGS (₹)", "GM %",
		"Freight (₹)", "Packaging (₹)", "Txn Fees (₹)", "Scheme (₹)", "Marketing (₹)",
		"CM2 %", "CM3 %",
	]
	_header_row(ws, base_cols + month_keys)

	for i, r in enumerate(rows, start=1):
		row = [
			i, r["item_code"], r["item_name"], r["item_group"], r["intent"],
			r["qty"], r["revenue"], r["cogs"], r["gm_pct"] / 100,
			r["alloc_freight"], r["alloc_packaging"], r["alloc_commission"],
			r["alloc_scheme"], r["alloc_marketing"],
			r["cm2_pct"] / 100, r["cm3_pct"] / 100,
		]
		for mk in month_keys:
			row.append(r["monthly"].get(mk, 0.0))
		ws.append(row)
		rnum = ws.max_row
		# Number formats
		for col in (6,):
			ws.cell(row=rnum, column=col).number_format = _NUM_FMT_INT
		for col in (7, 8, 10, 11, 12, 13, 14):
			ws.cell(row=rnum, column=col).number_format = _NUM_FMT_INR
		for col in (9, 15, 16):
			ws.cell(row=rnum, column=col).number_format = _NUM_FMT_PCT
		for col_idx in range(len(base_cols) + 1, len(base_cols) + 1 + len(month_keys)):
			ws.cell(row=rnum, column=col_idx).number_format = _NUM_FMT_INR

	ws.freeze_panes = "F2"  # freeze first 5 cols + header
	_write_provenance(
		ws,
		res,
		f"Allocations: freight {res['allocation']['freight_pct']:.2f}% · "
		f"pkg {res['allocation']['packaging_pct']:.2f}% · "
		f"txn {res['allocation']['commission_pct']:.2f}% · "
		f"marketing {res['allocation']['marketing_pct']:.2f}% of revenue.",
	)
	_autofit(ws, [5, 14, 32, 18, 14, 10, 14, 14, 9, 13, 13, 13, 12, 14, 9, 9] + [11] * len(month_keys))


def _write_segments_sheet(wb: Workbook, res: dict) -> None:
	ws = wb.create_sheet("Customer Segments")
	rows = res.get("segments", [])
	_header_row(
		ws,
		[
			"Segment", "Customers", "Invoices", "Revenue (₹)",
			"% Mix", "YoY %", "AOV (₹)", "GP (₹)", "GM %",
		],
	)
	total_rev = res["totals"]["revenue"] or 1
	for r in rows:
		share = r["revenue"] / total_rev
		yoy = (r["yoy_pct"] / 100) if r["yoy_pct"] is not None else None
		ws.append([
			r["segment"], r["customers"], r["invoices"], r["revenue"],
			share, yoy, r["aov"], r["gp"], r["gm_pct"] / 100,
		])
		rnum = ws.max_row
		ws.cell(row=rnum, column=2).number_format = _NUM_FMT_INT
		ws.cell(row=rnum, column=3).number_format = _NUM_FMT_INT
		ws.cell(row=rnum, column=4).number_format = _NUM_FMT_INR
		ws.cell(row=rnum, column=5).number_format = _NUM_FMT_PCT
		ws.cell(row=rnum, column=6).number_format = _NUM_FMT_PCT
		ws.cell(row=rnum, column=7).number_format = _NUM_FMT_INR
		ws.cell(row=rnum, column=8).number_format = _NUM_FMT_INR
		ws.cell(row=rnum, column=9).number_format = _NUM_FMT_PCT

	# Top-3 customers per segment inline, as a secondary block below.
	ws.append([])
	ws.append(["— Top customers per segment —"])
	ws.cell(row=ws.max_row, column=1).font = _SECTION_FONT
	_header_row(ws, ["Segment", "Customer", "Invoices", "Revenue (₹)", "% of Segment"])
	for r in rows:
		if not r["top_customers"]:
			continue
		seg_rev = r["revenue"] or 1
		for c in r["top_customers"][:5]:
			share = c["revenue"] / seg_rev
			ws.append([r["segment"], c["customer_name"], c["invoices"], c["revenue"], share])
			rnum = ws.max_row
			ws.cell(row=rnum, column=3).number_format = _NUM_FMT_INT
			ws.cell(row=rnum, column=4).number_format = _NUM_FMT_INR
			ws.cell(row=rnum, column=5).number_format = _NUM_FMT_PCT

	scope_note = (
		f"Scoped to {', '.join(res['scope_roots'])} (descendants rolled up)"
		if res.get("scope_roots")
		else "All Customer Groups with sales in the period"
	)
	_write_provenance(ws, res, scope_note)
	_autofit(ws, [30, 12, 12, 16, 10, 10, 14, 14, 10])


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


def _kv_row(ws, key: str, value: float | int | str, fmt: str | None = None) -> None:
	ws.append([key, value])
	if fmt:
		ws.cell(row=ws.max_row, column=2).number_format = fmt


def _write_provenance(ws, res: dict, note: str) -> None:
	ws.append([])
	ws.append(["Provenance"])
	ws.cell(row=ws.max_row, column=1).font = _SECTION_FONT
	ws.append(["Company", res.get("company", "—")])
	ws.append(["Period", res.get("period", {}).get("label", "—")])
	ws.append(["Tax mode", res.get("tax_mode", "—")])
	ws.append(["Exported", datetime.now(timezone.utc).isoformat(timespec="seconds")])
	ws.append(["Notes", note])
	ws.cell(row=ws.max_row, column=2).alignment = Alignment(wrap_text=True)
	for col in (1,):
		for row in range(ws.max_row - 5, ws.max_row + 1):
			ws.cell(row=row, column=col).font = _MUTED_FONT


def _autofit(ws, widths: list[int]) -> None:
	for i, w in enumerate(widths, start=1):
		ws.column_dimensions[get_column_letter(i)].width = w
