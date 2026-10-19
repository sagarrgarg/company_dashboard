"""Controls — the checks that prove the dashboard ties out.

Each check returns ``{key, group, label, status, expected, actual, difference, detail,
links}`` where status is ``pass`` | ``warn`` | ``fail`` | ``info``. Tolerance is ₹1
(display rounding). The ERPNext-report cross-checks run the standard reports themselves
(P&L, Balance Sheet, Gross Profit), so "matches ERPNext" means exactly that.
"""

from __future__ import annotations

from urllib.parse import urlencode

import frappe
from frappe.utils import add_days, flt, getdate

from company_dashboard.api.finance import _overall_steps, gl_report_url
from company_dashboard.api.mis import (
	_compute_customer_segments,
	_compute_overview,
	_compute_sku_assortment,
	_finance_book_clause,
	_period_dict,
	_period_for,
	_require_mis_access,
	_resolve_company,
	_sales_lines,
	_ttm_cache_anchor,
)
from company_dashboard.api.statements import (
	_bs_totals,
	_compute_cash_flow,
	_snapshot,
	classify_accounts,
)

TOL = 1.0


def _check(key, group, label, expected, actual, detail="", links=None, status=None, tol=TOL) -> dict:
	diff = None
	if expected is not None and actual is not None:
		diff = flt(actual) - flt(expected)
	if status is None:
		status = "pass" if (diff is not None and abs(diff) < tol) else "fail"
	return {
		"key": key,
		"group": group,
		"label": label,
		"status": status,
		"expected": expected,
		"actual": actual,
		"difference": diff,
		"detail": detail,
		"links": links or [],
	}


def _report_link(name: str, filters: dict) -> dict:
	return {
		"label": f"Open {name} in ERPNext",
		"url": f"/app/query-report/{name.replace(' ', '%20')}?" + urlencode(filters),
	}


def _gl_scalar(sql: str, params: dict) -> float:
	return flt(frappe.db.sql(sql, params)[0][0])


def _compute_controls(
	from_date: str | None = None, to_date: str | None = None, company: str | None = None
) -> dict:
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	f, t = period.from_date, period.to_date
	fstr, tstr = f.isoformat(), t.isoformat()
	checks: list[dict] = []
	base_filters = {"company": company, "from_date": fstr, "to_date": tstr}

	# ── Ledger integrity ──
	params: dict = {"company": company, "to": t}
	fb = _finance_book_clause(company, params)
	tb = _gl_scalar(
		f"select coalesce(sum(ge.debit) - sum(ge.credit), 0) from `tabGL Entry` ge where ge.company=%(company)s and ge.is_cancelled=0 and ge.posting_date <= %(to)s {fb}",
		params,
	)
	checks.append(
		_check(
			"trial_balance",
			"Ledger",
			"Trial balance: total debits = total credits",
			0.0,
			tb,
			"Σ debit − Σ credit over every GL entry up to the period end.",
			[_report_link("Trial Balance", {"company": company, "from_date": fstr, "to_date": tstr})],
		)
	)

	classes = classify_accounts(company)
	snap = _snapshot(company, t, classes)
	bst = _bs_totals(snap)
	checks.append(
		_check(
			"bs_balances",
			"Balance sheet",
			"Assets = equity + liabilities (incl. unclosed P&L)",
			bst["assets"],
			bst["equity_liabilities"],
			"Schedule III balance sheet as of the period end.",
		)
	)
	unclosed = snap["provisional"]["prior_unclosed"]
	checks.append(
		_check(
			"prior_years_closed",
			"Balance sheet",
			"Earlier years closed (Period Closing Voucher)",
			0.0,
			unclosed,
			"P&L of earlier fiscal years still sitting in income/expense accounts. Non-zero means a year was not closed.",
			status="pass" if abs(unclosed) < TOL else "warn",
		)
	)
	fallback = {a for a, c in classes.items() if c["rule"].startswith("fallback")}
	fallback_bal = sum(
		abs(x["amount"]) for rows in snap["accounts"].values() for x in rows if x["account"] in fallback
	)
	checks.append(
		_check(
			"bs_mapping",
			"Balance sheet",
			"Every balance-sheet account placed on a Schedule III line by rule",
			0.0,
			fallback_bal,
			f"{len(fallback)} account(s) fell back to a default line by root type. Map them in Company Dashboard Settings → Balance sheet line overrides.",
			[{"label": "Company Dashboard Settings", "url": "/app/company-dashboard-settings"}],
			status="pass" if fallback_bal < TOL else "warn",
		)
	)

	# ── P&L ──
	o = _compute_overview("excl", fstr, tstr, company)
	k = o["kpi"]
	checks.append(
		_check(
			"pat_gl",
			"P&L",
			"Dashboard PAT = GL net profit",
			k["gl_net_profit"],
			k["pat"],
			"Every P&L account is on a ladder line (mapped bucket, cost of goods, other, internal), so they must agree.",
			[{"label": "General Ledger (P&L accounts)", "url": gl_report_url(company, [], f, t)}],
		)
	)
	fy_start = snap["provisional"]["fy_start"]
	if f == fy_start:
		checks.append(
			_check(
				"pat_bs",
				"P&L",
				"PAT = current-year P&L carried on the balance sheet",
				snap["provisional"]["current_fy"],
				k["pat"],
				"The period is the fiscal year to date, so its PAT must equal the balance sheet's current-year P&L.",
			)
		)
	buckets = sum(k[f"{b}_pat"] for b in ("b2c", "b2b", "unclassified"))
	checks.append(_check("buckets_sum", "P&L", "B2C + B2B + unclassified PAT = total PAT", k["pat"], buckets))
	rev_buckets = sum(k[f"{b}_revenue_excl"] for b in ("b2c", "b2b", "unclassified"))
	checks.append(
		_check(
			"revenue_buckets",
			"P&L",
			"B2C + B2B + unclassified revenue = total revenue",
			k["total_revenue_excl"],
			rev_buckets,
		)
	)
	bad_sources = []
	for b, steps in o["pnl"].items():
		for st in steps:
			if st["kind"] == "tier":
				total = sum(c["amount"] for c in st.get("components", []))
				if abs(total - st["amount"]) >= TOL:
					bad_sources.append(f"{b}/{st['key']}")
			else:
				val = st["amount"] if st["kind"] == "anchor" else -st["amount"]
				if abs(sum(x["amount"] for x in st.get("sources", [])) - val) >= TOL:
					bad_sources.append(f"{b}/{st['key']}")
	checks.append(
		_check(
			"explain_integrity",
			"P&L",
			"Every 'explain' breakdown adds up to its number",
			0,
			len(bad_sources),
			", ".join(bad_sources) or "All ledgers behind every line sum to the line, in every bucket.",
			tol=0.5,
		)
	)
	sku = _compute_sku_assortment("excl", fstr, tstr, "all", company)
	checks.append(
		_check(
			"sku_ties",
			"P&L",
			"SKU page gross profit (incl. unallocated cost) = CM1",
			k["gross_profit"],
			sku["totals"]["gp"],
		)
	)
	seg = _compute_customer_segments("excl", fstr, tstr, "all", 10, 10, company)
	if not seg["is_scoped"]:
		checks.append(
			_check(
				"segments_tie",
				"P&L",
				"Segment gross profit (incl. unallocated cost) = CM1",
				k["gross_profit"],
				seg["totals"]["gp_after_unallocated"],
			)
		)
	unmapped = k["other_expenses"]
	checks.append(
		_check(
			"pl_mapping",
			"P&L",
			"Expense accounts not mapped to a bucket",
			0.0,
			unmapped,
			f"{len(o['ladder_inputs']['unmapped_expense_accounts'])} account(s) shown as 'Other expenses'. Map them in Company Dashboard Settings.",
			[{"label": "Company Dashboard Settings", "url": "/app/company-dashboard-settings"}],
			status="pass" if abs(unmapped) < TOL else "info",
		)
	)

	# Revenue ↔ invoices: income posted by Sales Invoices = invoice-line net amounts.
	p2: dict = {"company": company, "from": f, "to": t}
	fb2 = _finance_book_clause(company, p2)
	gl_si_income = -_gl_scalar(
		f"""select coalesce(sum(ge.debit) - sum(ge.credit), 0) from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
		where ge.company=%(company)s and ge.is_cancelled=0 and ge.posting_date between %(from)s and %(to)s
		  and ge.voucher_type = 'Sales Invoice' and a.root_type = 'Income'
		  and a.account_type not in ('Round Off') {fb2}""",
		p2,
	)
	sii_net = _gl_scalar(
		"""select coalesce(sum(sii.base_net_amount), 0) from `tabSales Invoice Item` sii join `tabSales Invoice` si on si.name = sii.parent
		where si.docstatus = 1 and si.company = %(company)s and si.posting_date between %(from)s and %(to)s""",
		{"company": company, "from": f, "to": t},
	)
	checks.append(
		_check(
			"revenue_invoices",
			"P&L",
			"Income posted by Sales Invoices = invoice-line net amounts",
			sii_net,
			gl_si_income,
			"All Sales Invoices (internal customers included), ex-tax, returns netted. A gap means income booked on invoice charges/taxes rows or rounding.",
			[_report_link("Sales Register", base_filters)],
			tol=max(TOL, abs(sii_net) * 0.0001),
		)
	)

	# ── Sub-ledgers vs control accounts ──
	for party_type, acc_type, rpt in (
		("Customer", "Receivable", "Accounts Receivable"),
		("Supplier", "Payable", "Accounts Payable"),
	):
		accounts = frappe.get_all(
			"Account", filters={"company": company, "account_type": acc_type, "is_group": 0}, pluck="name"
		)
		if not accounts:
			continue
		p3: dict = {"company": company, "to": t, "accounts": tuple(accounts)}
		fb3 = _finance_book_clause(company, p3)
		gl_bal = _gl_scalar(
			f"select coalesce(sum(ge.debit) - sum(ge.credit), 0) from `tabGL Entry` ge where ge.company=%(company)s and ge.is_cancelled=0 and ge.posting_date <= %(to)s and ge.account in %(accounts)s {fb3}",
			p3,
		)
		ple = (
			flt(
				frappe.db.sql(
					"""select coalesce(sum(amount), 0) from `tabPayment Ledger Entry`
				where company=%(company)s and delinked=0 and posting_date <= %(to)s and account in %(accounts)s""",
					p3,
				)[0][0]
			)
			if frappe.db.table_exists("Payment Ledger Entry")
			else None
		)
		sign = 1 if acc_type == "Receivable" else -1
		if ple is not None:
			checks.append(
				_check(
					f"{acc_type.lower()}_subledger",
					"Sub-ledgers",
					f"{party_type} ledger (Payment Ledger) = {acc_type} control accounts",
					sign * gl_bal,
					ple,
					f"Payment Ledger outstanding vs GL balance on {len(accounts)} {acc_type.lower()} account(s), as of the period end.",
					[_report_link(rpt, {"company": company, "report_date": tstr})],
				)
			)
	stock_accounts = frappe.get_all(
		"Account", filters={"company": company, "account_type": "Stock", "is_group": 0}, pluck="name"
	)
	if stock_accounts:
		p4: dict = {"company": company, "to": t, "accounts": tuple(stock_accounts)}
		fb4 = _finance_book_clause(company, p4)
		gl_stock = _gl_scalar(
			f"select coalesce(sum(ge.debit) - sum(ge.credit), 0) from `tabGL Entry` ge where ge.company=%(company)s and ge.is_cancelled=0 and ge.posting_date <= %(to)s and ge.account in %(accounts)s {fb4}",
			p4,
		)
		sle_value = _gl_scalar(
			"""select coalesce(sum(sle.stock_value_difference), 0) from `tabStock Ledger Entry` sle
			join `tabWarehouse` w on w.name = sle.warehouse
			where w.company = %(company)s and sle.is_cancelled = 0 and sle.posting_date <= %(to)s""",
			{"company": company, "to": t},
		)
		checks.append(
			_check(
				"stock_subledger",
				"Sub-ledgers",
				"Stock ledger value = Stock accounts in GL",
				gl_stock,
				sle_value,
				"Σ stock value change in the stock ledger vs GL Stock accounts, as of the period end. A gap usually means a pending repost, stock entries with no GL, or a JV to a stock account.",
				[
					_report_link(
						"Stock and Account Value Comparison", {"company": company, "as_on_date": tstr}
					)
				],
				tol=max(TOL, abs(gl_stock) * 0.0005),
			)
		)

	# ── Cash flow ──
	cf = _compute_cash_flow(fstr, tstr, company)
	checks.append(
		_check(
			"cash_flow_ties",
			"Cash flow",
			"Opening cash + net cash flow = closing balance-sheet cash",
			cf["closing_cash"],
			cf["opening_cash"] + cf["net_change"],
			"Every balance-sheet line moves into exactly one cash-flow section, so this holds unless an entry is unbalanced.",
		)
	)

	# ── ERPNext standard reports ──
	checks.extend(_erpnext_report_checks(company, f, t, k, bst, snap))

	order = {"fail": 0, "warn": 1, "info": 2, "pass": 3}
	summary = {s: sum(1 for c in checks if c["status"] == s) for s in ("pass", "warn", "fail", "info")}
	return {
		"company": company,
		"period": _period_dict(period, company),
		"summary": summary,
		"checks": sorted(checks, key=lambda c: (order[c["status"]], c["group"])),
	}


def _erpnext_report_checks(company, f, t, kpi, bst, snap) -> list[dict]:
	"""Run ERPNext's own P&L, Balance Sheet and Gross Profit reports and compare."""
	from company_dashboard.api.erpnext_reports import (
		balance_sheet_totals,
		cash_flow_net,
		gross_profit_totals,
		profit_and_loss_net,
	)

	out = []
	fstr, tstr = f.isoformat(), t.isoformat()
	try:
		pl = profit_and_loss_net(company, f, t)
		out.append(
			_check(
				"erpnext_pl",
				"ERPNext reports",
				"Dashboard PAT = ERPNext Profit and Loss Statement",
				pl["net_profit"],
				kpi["pat"],
				pl.get("note", ""),
				[_report_link("Profit and Loss Statement", pl["filters"])],
			)
		)
	except Exception as e:
		out.append(
			_check(
				"erpnext_pl",
				"ERPNext reports",
				"ERPNext Profit and Loss Statement",
				None,
				None,
				f"Could not run: {e}",
				status="warn",
			)
		)
	try:
		bs = balance_sheet_totals(company, t)
		out.append(
			_check(
				"erpnext_bs_assets",
				"ERPNext reports",
				"Total assets = ERPNext Balance Sheet",
				bs["assets"],
				bst["assets"],
				bs.get("note", ""),
				[_report_link("Balance Sheet", bs["filters"])],
			)
		)
		out.append(
			_check(
				"erpnext_bs_pl",
				"ERPNext reports",
				"Unclosed P&L = ERPNext Balance Sheet provisional profit/loss",
				bs["provisional"],
				snap["provisional"]["total"],
				"ERPNext's 'Provisional Profit / Loss (Credit)' (+ unclosed earlier years).",
				[_report_link("Balance Sheet", bs["filters"])],
			)
		)
	except Exception as e:
		out.append(
			_check(
				"erpnext_bs",
				"ERPNext reports",
				"ERPNext Balance Sheet",
				None,
				None,
				f"Could not run: {e}",
				status="warn",
			)
		)
	try:
		erp_cf = cash_flow_net(company, f, t)
		cf = _compute_cash_flow(fstr, tstr, company)
		out.append(
			_check(
				"erpnext_cf",
				"ERPNext reports",
				"Net change in cash vs ERPNext Cash Flow report",
				erp_cf["net_change"],
				cf["net_change"],
				"ERPNext's Cash Flow only follows Receivable, Payable, Stock, Depreciation, Fixed Asset and Equity account types, so any other "
				"balance-sheet movement (taxes, loans, advances, opening entries…) is missing there. The dashboard's cash flow ties to actual cash.",
				[_report_link("Cash Flow", erp_cf["filters"])],
				status="info",
			)
		)
	except Exception as e:
		out.append(
			_check(
				"erpnext_cf",
				"ERPNext reports",
				"ERPNext Cash Flow",
				None,
				None,
				f"Could not run: {e}",
				status="info",
			)
		)
	try:
		gp = gross_profit_totals(company, f, t)
		out.append(
			_check(
				"erpnext_gp_revenue",
				"ERPNext reports",
				"Invoice-line revenue (all customers) = ERPNext Gross Profit selling amount",
				gp["selling_amount"],
				gp["dashboard_selling_amount"],
				"Same invoices on both sides (internal customers included, as the report does).",
				[_report_link("Gross Profit", gp["filters"])],
				tol=max(TOL, abs(gp["selling_amount"]) * 0.0001),
			)
		)
		out.append(
			_check(
				"erpnext_gp_cost",
				"ERPNext reports",
				"GL cost of goods vs ERPNext Gross Profit buying amount",
				gp["buying_amount"],
				kpi["cogs"],
				gp.get("bridge_note", ""),
				[_report_link("Gross Profit", gp["filters"])],
				status="info",
			)
			| {"bridge": gp.get("bridge")}
		)
	except Exception as e:
		out.append(
			_check(
				"erpnext_gp",
				"ERPNext reports",
				"ERPNext Gross Profit",
				None,
				None,
				f"Could not run: {e}",
				status="warn",
			)
		)
	return out


@frappe.whitelist()
def get_controls(
	from_date: str | None = None, to_date: str | None = None, company: str | None = None
) -> dict:
	"""Every reconciliation check for the period, worst first."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	kwargs = {"from_date": from_date, "to_date": to_date, "company": company}
	return _cached(
		"mis",
		"controls",
		lambda: _compute_controls(**kwargs),
		{**kwargs, **_ttm_cache_anchor(from_date, to_date)},
		job=("company_dashboard.api.controls._compute_controls", kwargs),
	)


# ── Exceptions / alerts ────────────────────────────────────────────────────


def _alert(key, severity, label, count, amount, detail, links=None, rows=None) -> dict:
	return {
		"key": key,
		"severity": severity,  # high | medium | low
		"label": label,
		"count": count,
		"amount": amount,
		"detail": detail,
		"links": links or [],
		"rows": rows or [],
	}


def _compute_alerts(
	from_date: str | None = None, to_date: str | None = None, company: str | None = None
) -> dict:
	from company_dashboard.api.finance import desk_url

	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	f, t = period.from_date, period.to_date
	alerts: list[dict] = []

	# Stock: negative bins, failed / pending reposts.
	neg = frappe.db.sql(
		"""select b.item_code, b.warehouse, b.actual_qty, b.stock_value from `tabBin` b
		join `tabWarehouse` w on w.name = b.warehouse
		where w.company = %s and b.actual_qty < 0 order by b.stock_value asc""",
		company,
		as_dict=True,
	)
	if neg:
		alerts.append(
			_alert(
				"negative_stock",
				"high",
				"Negative stock",
				len(neg),
				sum(flt(r.stock_value) for r in neg),
				"Items whose stock went below zero. Their valuation (and cost of goods) is unreliable until stock is corrected and reposted.",
				[
					{
						"label": "Stock Balance",
						"url": "/app/query-report/Stock%20Balance?" + urlencode({"company": company}),
					}
				],
				[
					{
						"label": f"{r.item_code} @ {r.warehouse}",
						"amount": flt(r.stock_value),
						"qty": flt(r.actual_qty),
						"url": desk_url("Item", r.item_code),
					}
					for r in neg[:20]
				],
			)
		)
	if frappe.db.table_exists("Repost Item Valuation"):
		pending = frappe.db.sql(
			"""select status, count(*) from `tabRepost Item Valuation`
			where company = %s and docstatus = 1 and status in ('Queued', 'In Progress', 'Failed') group by status""",
			company,
		)
		total = sum(c for _s, c in pending)
		if total:
			alerts.append(
				_alert(
					"reposts",
					"high" if any(s == "Failed" for s, _c in pending) else "medium",
					"Stock reposts not completed",
					total,
					None,
					", ".join(f"{c} {s.lower()}" for s, c in pending)
					+ ". Stock and cost-of-goods figures will change once they complete.",
					[{"label": "Repost Item Valuation", "url": "/app/repost-item-valuation?status=Failed"}],
				)
			)

	# Sales: lines with impossible cost, and lines sold below cost.
	lines = _sales_lines(company, f, t)
	flagged = [ln for ln in lines if ln.flagged]
	if flagged:
		alerts.append(
			_alert(
				"impossible_cost",
				"high",
				"Invoice lines with impossible stock cost",
				len(flagged),
				sum(ln.cost or 0 for ln in flagged),
				"Cost more than 5× revenue, or unit cost more than 10× the item's median. Kept out of SKU/segment splits until fixed.",
				rows=[
					{
						"label": f"{ln.invoice} · {ln.item_code}",
						"amount": ln.cost,
						"url": desk_url("Sales Invoice", ln.invoice),
					}
					for ln in sorted(flagged, key=lambda ln: -abs(ln.cost or 0))[:20]
				],
			)
		)
	below = [
		ln
		for ln in lines
		if ln.valued and not ln.flagged and ln.rev_excl > 0 and (ln.cost or 0) > ln.rev_excl
	]
	if below:
		loss = sum((ln.cost or 0) - ln.rev_excl for ln in below)
		alerts.append(
			_alert(
				"below_cost",
				"medium",
				"Sold below stock cost",
				len(below),
				loss,
				"Invoice lines whose ex-tax price was lower than their stock-ledger cost (loss shown).",
				rows=[
					{
						"label": f"{ln.invoice} · {ln.item_code}",
						"amount": (ln.cost or 0) - ln.rev_excl,
						"url": desk_url("Sales Invoice", ln.invoice),
					}
					for ln in sorted(below, key=lambda ln: -((ln.cost or 0) - ln.rev_excl))[:20]
				],
			)
		)

	# Receivables > 90 days and MSME payables (43B(h): pay within 45 days).
	try:
		from company_dashboard.api.wc import get_wc_snapshot

		snap = get_wc_snapshot(company)
		buckets = snap["receivable"]["aging"]["buckets"]
		over90 = sum(
			b["amount"] for b in buckets if not b.get("reconciling") and b["label"].startswith(("91", ">"))
		)
		if over90 >= 1:
			alerts.append(
				_alert(
					"ar_90",
					"high",
					"Receivables older than 90 days",
					None,
					over90,
					"From the BNS FIFO ageing, as of today.",
					[
						{
							"label": "Accounts Receivable",
							"url": "/app/query-report/Accounts%20Receivable?"
							+ urlencode({"company": company}),
						}
					],
					[
						{
							"label": d["party_name"],
							"amount": d["outstanding"],
							"age": d["age_days"],
							"url": desk_url("Customer", d["party"]),
						}
						for d in snap["receivable"]["top_debtors"]
						if d["age_days"] >= 91
					],
				)
			)
		if frappe.db.has_column("Supplier", "custom_msme_registered"):
			msme = set(frappe.get_all("Supplier", filters={"custom_msme_registered": 1}, pluck="name"))
			due = [c for c in snap["payable"]["top_creditors"] if c["party"] in msme and c["age_days"] >= 31]
			if due:
				alerts.append(
					_alert(
						"msme_45",
						"high",
						"MSME suppliers with dues over 30 days",
						len(due),
						sum(c["outstanding"] for c in due),
						"Section 43B(h): dues to MSME manufacturers / service providers unpaid beyond 45 days are disallowed as expense until paid. Ageing buckets are 30-day, so this lists everything past 30 days among the top creditors.",
						rows=[
							{
								"label": c["party_name"],
								"amount": c["outstanding"],
								"age": c["age_days"],
								"url": desk_url("Supplier", c["party"]),
							}
							for c in due
						],
					)
				)
	except frappe.PermissionError:
		pass

	# Accounting hygiene.
	params: dict = {"company": company, "from": f, "to": t}
	fb = _finance_book_clause(company, params)
	manual = frappe.db.sql(
		f"""
		select ge.voucher_no, max(ge.posting_date) as posting_date, sum(abs(ge.debit - ge.credit)) as amount,
		       group_concat(distinct ge.account separator ', ') as accounts
		from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
		where ge.company = %(company)s and ge.is_cancelled = 0 and ge.voucher_type = 'Journal Entry'
		  and ge.posting_date between %(from)s and %(to)s
		  and (a.root_type = 'Income' or a.account_type in ('Cost of Goods Sold', 'Stock', 'Stock Adjustment')) {fb}
		group by ge.voucher_no
		order by sum(abs(ge.debit - ge.credit)) desc
		""",
		params,
		as_dict=True,
	)
	if manual:
		alerts.append(
			_alert(
				"manual_je",
				"medium",
				"Journal entries posted to revenue, cost of goods or stock",
				len(manual),
				sum(flt(r.amount) for r in manual),
				"Manual entries on these accounts bypass invoices and the stock ledger; review that each is intended.",
				rows=[
					{
						"label": f"{r.voucher_no} · {(r.accounts or '')[:80]}",
						"amount": flt(r.amount),
						"url": desk_url("Journal Entry", r.voucher_no),
					}
					for r in manual[:20]
				],
			)
		)
	suspense = frappe.db.sql(
		f"""
		select ge.account, sum(ge.debit) - sum(ge.credit) as bal
		from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
		where ge.company = %(company)s and ge.is_cancelled = 0 and ge.posting_date <= %(to)s
		  and (a.account_type in ('Temporary', 'Round Off', 'Round Off for Opening') or a.account_name like '%%suspense%%') {fb}
		group by ge.account having abs(sum(ge.debit) - sum(ge.credit)) >= 1000
		""",
		params,
		as_dict=True,
	)
	if suspense:
		alerts.append(
			_alert(
				"suspense",
				"low",
				"Balances left in temporary / suspense / round-off accounts",
				len(suspense),
				sum(abs(flt(r.bal)) for r in suspense),
				"These should be cleared to zero.",
				rows=[
					{"label": r.account, "amount": flt(r.bal), "url": desk_url("Account", r.account)}
					for r in suspense
				],
			)
		)
	backdated = frappe.db.sql(
		f"""
		select ge.voucher_type, ge.voucher_no, min(ge.posting_date) as posting_date, max(ge.creation) as created,
		       sum(ge.debit) as amount
		from `tabGL Entry` ge
		where ge.company = %(company)s and ge.is_cancelled = 0
		  and ge.creation >= now() - interval 7 day and ge.posting_date < curdate() - interval 30 day {fb}
		group by ge.voucher_type, ge.voucher_no
		order by sum(ge.debit) desc
		""",
		params,
		as_dict=True,
	)
	if backdated:
		alerts.append(
			_alert(
				"backdated",
				"medium",
				"Back-dated entries in the last 7 days",
				len(backdated),
				sum(flt(r.amount) for r in backdated),
				"Posted this week into dates more than 30 days old — earlier months' figures have changed.",
				rows=[
					{
						"label": f"{r.voucher_type} {r.voucher_no} (dated {r.posting_date})",
						"amount": flt(r.amount),
						"url": desk_url(r.voucher_type, r.voucher_no),
					}
					for r in backdated[:20]
				],
			)
		)
	drafts = []
	for dt in (
		"Sales Invoice",
		"Purchase Invoice",
		"Delivery Note",
		"Purchase Receipt",
		"Journal Entry",
		"Payment Entry",
		"Stock Entry",
	):
		n = frappe.db.count(dt, {"docstatus": 0, "company": company, "posting_date": ("between", [f, t])})
		if n:
			drafts.append(
				{
					"label": dt,
					"amount": None,
					"count": n,
					"url": f"/app/{frappe.scrub(dt).replace('_', '-')}?docstatus=0",
				}
			)
	if drafts:
		alerts.append(
			_alert(
				"drafts",
				"low",
				"Draft documents in the period (not in any figure)",
				sum(d["count"] for d in drafts),
				None,
				"Drafts don't post to the ledger. Submit or cancel them to close the period.",
				rows=drafts,
			)
		)

	order = {"high": 0, "medium": 1, "low": 2}
	alerts.sort(key=lambda a: order[a["severity"]])
	return {
		"company": company,
		"period": _period_dict(period, company),
		"alerts": alerts,
		"counts": {s: sum(1 for a in alerts if a["severity"] == s) for s in ("high", "medium", "low")},
	}


@frappe.whitelist()
def get_alerts(from_date: str | None = None, to_date: str | None = None, company: str | None = None) -> dict:
	"""Exceptions that need attention, most severe first."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	kwargs = {"from_date": from_date, "to_date": to_date, "company": company}
	return _cached(
		"mis",
		"alerts",
		lambda: _compute_alerts(**kwargs),
		{**kwargs, **_ttm_cache_anchor(from_date, to_date)},
		job=("company_dashboard.api.controls._compute_alerts", kwargs),
	)
