"""Working Capital dashboard API.

All data comes from ERPNext GL Entry, Payment Ledger Entry, and Bin tables.
AR/AP aging reuses the BNS Pure Accounts Receivable/Payable Summary reports
with FIFO running-account adjustment so numbers match the BNS reports exactly.
"""

from __future__ import annotations

from datetime import date, timedelta

import frappe
from frappe.utils import add_months, flt, getdate, today

from company_dashboard.api.mis import _require_wc_access
from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
	get_wc_exclude_customer_groups,
	get_wc_exclude_supplier_groups,
)

# Internal customer/supplier filter — same logic as MIS to exclude intercompany.
_INTERNAL_CUSTOMER_FILTER = """
	and coalesce(c.is_internal_customer, 0) = 0
	and coalesce(c.is_bns_internal_customer, 0) = 0
"""
_INTERNAL_SUPPLIER_FILTER = """
	and coalesce(sup.is_internal_supplier, 0) = 0
"""


# ── helpers ─────────────────────────────────────────────────────────────────

def _default_company() -> str:
	company = frappe.defaults.get_global_default("company")
	if company:
		return company
	rows = frappe.get_all("Company", filters={"disabled": 0}, fields=["name"], order_by="creation asc", limit=1)
	return rows[0]["name"] if rows else ""


def _customer_group_exclude_clause(params: dict) -> str:
	"""SQL clause + params injection for excluded customer groups."""
	groups = get_wc_exclude_customer_groups()
	if not groups:
		return ""
	params["_excl_cgroups"] = tuple(groups)
	return "and coalesce(c.customer_group, '') not in %(_excl_cgroups)s"


def _supplier_group_exclude_clause(params: dict) -> str:
	"""SQL clause + params injection for excluded supplier groups."""
	groups = get_wc_exclude_supplier_groups()
	if not groups:
		return ""
	params["_excl_sgroups"] = tuple(groups)
	return "and coalesce(sup.supplier_group, '') not in %(_excl_sgroups)s"


# ── BANK BALANCE ────────────────────────────────────────────────────────────

def _get_bank_accounts(company: str) -> list[str]:
	"""Bank accounts for a company — same filter as BNS bank_gl.js: account_type = 'Bank'."""
	return frappe.get_all(
		"Account",
		filters={"company": company, "account_type": "Bank", "is_group": 0, "disabled": 0},
		pluck="name",
	)


def _bank_balance_per_account(company: str) -> list[dict]:
	"""Per-account balance (debit − credit) and last posting date."""
	accounts = _get_bank_accounts(company)
	if not accounts:
		return []
	rows = frappe.db.sql(
		"""
		select
			account,
			sum(debit) - sum(credit) as balance,
			max(posting_date) as last_posting_date
		from `tabGL Entry`
		where account in %(accounts)s
		  and company = %(company)s
		  and is_cancelled = 0
		group by account
		order by balance desc
		""",
		{"accounts": tuple(accounts), "company": company},
		as_dict=True,
	)
	return [
		{
			"account": r["account"],
			"balance": flt(r["balance"]),
			"last_posting_date": r["last_posting_date"].isoformat() if r["last_posting_date"] else None,
		}
		for r in rows
	]


def _bank_monthly_trend(company: str, months: int = 6) -> list[dict]:
	"""Monthly opening balance across all bank accounts for the last N months."""
	accounts = _get_bank_accounts(company)
	if not accounts:
		return []
	ref = getdate(today())
	# We compute cumulative balance as-of the 1st of each month
	points = []
	for i in range(months, 0, -1):
		dt = getdate(add_months(ref, -(i - 1)))
		first_of_month = dt.replace(day=1)
		rows = frappe.db.sql(
			"""
			select coalesce(sum(debit) - sum(credit), 0) as bal
			from `tabGL Entry`
			where account in %(accounts)s
			  and company = %(company)s
			  and posting_date < %(dt)s
			  and is_cancelled = 0
			""",
			{"accounts": tuple(accounts), "company": company, "dt": first_of_month},
			as_dict=True,
		)
		points.append({
			"month": first_of_month.strftime("%b"),
			"year": first_of_month.year,
			"balance": flt(rows[0]["bal"]) if rows else 0.0,
		})
	return points


def _cash_burn_rate(company: str) -> float:
	"""Average monthly net outflow from bank accounts over trailing 3 months."""
	accounts = _get_bank_accounts(company)
	if not accounts:
		return 0.0
	ref = getdate(today())
	three_months_ago = getdate(add_months(ref, -3))
	rows = frappe.db.sql(
		"""
		select coalesce(sum(credit) - sum(debit), 0) as outflow
		from `tabGL Entry`
		where account in %(accounts)s
		  and company = %(company)s
		  and posting_date >= %(from)s
		  and posting_date <= %(to)s
		  and is_cancelled = 0
		""",
		{"accounts": tuple(accounts), "company": company, "from": three_months_ago, "to": ref},
		as_dict=True,
	)
	total_outflow = flt(rows[0]["outflow"]) if rows else 0.0
	return max(total_outflow / 3, 0.0)


# ── AR / AP via BNS reports ─────────────────────────────────────────────────

def _run_receivable_summary(company: str, ranges: str = "30, 60, 90, 120") -> list[dict]:
	"""Run BNS Pure Accounts Receivable Summary (full execute with Party Link netting,
	FIFO aging adjustment, and negative-bucket redistribution).
	Post-filters internal customers and admin-excluded customer groups."""
	from business_needed_solutions.business_needed_solutions.report.pure_accounts_receivable_summary.pure_accounts_receivable_summary import (
		execute as ar_execute,
	)
	excl_groups = get_wc_exclude_customer_groups()
	filters = frappe._dict({
		"company": company,
		"report_date": today(),
		"ageing_based_on": "Posting Date",
		"range": ranges,
		"adjust_running_accounts": 1,
		"show_future_payments": 0,
		"show_gl_balance": 0,
		"exclude_customer_group": excl_groups or [],
	})
	_cols, data = ar_execute(filters)
	internal_customers = _get_internal_customers()
	return [row for row in data if row.get("party") not in internal_customers]


def _run_payable_summary(company: str, ranges: str = "30, 60, 90, 120") -> list[dict]:
	"""Run BNS Pure Accounts Payable Summary (full execute with Party Link netting,
	FIFO aging adjustment, and negative-bucket redistribution).
	Post-filters internal suppliers and admin-excluded supplier groups."""
	from business_needed_solutions.business_needed_solutions.report.pure_accounts_payable_summary.pure_accounts_payable_summary import (
		execute as ap_execute,
	)
	excl_groups = get_wc_exclude_supplier_groups()
	filters = frappe._dict({
		"company": company,
		"report_date": today(),
		"ageing_based_on": "Posting Date",
		"range": ranges,
		"adjust_running_accounts": 1,
		"show_future_payments": 0,
		"show_gl_balance": 0,
		"exclude_supplier_group": excl_groups or [],
	})
	_cols, data = ap_execute(filters)
	internal_suppliers = _get_internal_suppliers()
	return [row for row in data if row.get("party") not in internal_suppliers]


def _get_internal_customers() -> set[str]:
	"""Set of customer names that are internal (intercompany)."""
	rows = frappe.db.sql(
		"""
		select name from `tabCustomer`
		where coalesce(is_internal_customer, 0) = 1
		   or coalesce(is_bns_internal_customer, 0) = 1
		""",
		pluck=True,
	)
	return set(rows)


def _get_internal_suppliers() -> set[str]:
	"""Set of supplier names that are internal (intercompany)."""
	rows = frappe.db.sql(
		"""
		select name from `tabSupplier`
		where coalesce(is_internal_supplier, 0) = 1
		""",
		pluck=True,
	)
	return set(rows)


def _aggregate_aging(data: list[dict], ranges: str = "30, 60, 90, 120") -> dict:
	"""Aggregate per-party rows into aging buckets summary.
	Only considers parties with positive outstanding (skips advance balances)."""
	range_list = [r.strip() for r in ranges.split(",") if r.strip().isdigit()]
	num_buckets = len(range_list) + 1

	bucket_totals = [0.0] * num_buckets
	total_outstanding = 0.0
	total_overdue = 0.0

	for row in data:
		outstanding = flt(row.get("outstanding", 0))
		if outstanding <= 0:
			continue
		total_outstanding += outstanding
		for i in range(num_buckets):
			val = flt(row.get(f"range{i + 1}", 0))
			bucket_totals[i] += max(val, 0)
		for i in range(1, num_buckets):
			total_overdue += max(flt(row.get(f"range{i + 1}", 0)), 0)

	labels = []
	prev = 0
	for r in range_list:
		labels.append(f"{prev + 1} – {r} Days" if prev > 0 else f"0 – {r} Days")
		prev = int(r)
	labels.append(f"> {range_list[-1]} Days")

	buckets = []
	for i, label in enumerate(labels):
		pct = (bucket_totals[i] / total_outstanding * 100) if total_outstanding else 0
		buckets.append({"label": label, "amount": bucket_totals[i], "pct": round(pct, 1)})

	return {
		"total_outstanding": total_outstanding,
		"total_overdue": total_overdue,
		"buckets": buckets,
	}


def _top_parties(data: list[dict], limit: int = 10) -> list[dict]:
	"""Top N parties by outstanding amount, with age and status."""
	positive = [r for r in data if flt(r.get("outstanding", 0)) > 0]
	sorted_data = sorted(positive, key=lambda r: flt(r.get("outstanding", 0)), reverse=True)
	out = []
	for row in sorted_data[:limit]:
		outstanding = flt(row.get("outstanding", 0))
		age = 0
		# Use the highest non-zero range bucket to approximate age
		for i in range(5, 0, -1):
			if flt(row.get(f"range{i}", 0)) > 0:
				age = [0, 30, 60, 90, 120][min(i - 1, 4)]
				break

		if age > 60:
			status = "Overdue"
		elif age > 30:
			status = "Watch"
		else:
			status = "Current"

		out.append({
			"party": row.get("party", ""),
			"party_name": row.get("party_name", ""),
			"customer_group": row.get("customer_group", ""),
			"supplier_group": row.get("supplier_group", ""),
			"outstanding": outstanding,
			"age_days": age,
			"status": status,
			"invoiced": flt(row.get("invoiced", 0)),
			"paid": flt(row.get("paid", 0)),
		})
	return out


def _bns_ar_total(data: list[dict]) -> float:
	"""Net outstanding from BNS AR report rows (includes negatives from advances)."""
	return sum(flt(r.get("outstanding", 0)) for r in data)


def _bns_ap_total(data: list[dict]) -> float:
	"""Net outstanding from BNS AP report rows (includes negatives from advances)."""
	return sum(flt(r.get("outstanding", 0)) for r in data)


def _dso(company: str, ar_total: float | None = None, days: int = 365) -> float:
	"""Days Sales Outstanding = (Trade Receivable / Credit Sales) × Days."""
	ref = getdate(today())
	from_date = ref - timedelta(days=days)
	params: dict = {"company": company, "from": from_date, "to": ref}
	cg_clause = _customer_group_exclude_clause(params)
	rows = frappe.db.sql(
		f"""
		select coalesce(sum(si.base_grand_total), 0) as sales
		from `tabSales Invoice` si
		left join `tabCustomer` c on c.name = si.customer
		where si.docstatus = 1 and si.company = %(company)s
		  and si.posting_date between %(from)s and %(to)s
		  and si.is_return = 0
		  {_INTERNAL_CUSTOMER_FILTER}
		  {cg_clause}
		""",
		params,
		as_dict=True,
	)
	credit_sales = flt(rows[0]["sales"]) if rows else 0.0

	if ar_total is None:
		ar_total = _bns_ar_total(_run_receivable_summary(company))
	ar = max(ar_total, 0.0)
	if credit_sales <= 0:
		return 0.0
	return round(ar / credit_sales * days, 0)


def _dpo(company: str, ap_total: float | None = None, days: int = 365) -> float:
	"""Days Payable Outstanding = (Trade Payable / Purchases) × Days."""
	ref = getdate(today())
	from_date = ref - timedelta(days=days)
	params: dict = {"company": company, "from": from_date, "to": ref}
	sg_clause = _supplier_group_exclude_clause(params)
	rows = frappe.db.sql(
		f"""
		select coalesce(sum(pi.base_grand_total), 0) as purchases
		from `tabPurchase Invoice` pi
		left join `tabSupplier` sup on sup.name = pi.supplier
		where pi.docstatus = 1 and pi.company = %(company)s
		  and pi.posting_date between %(from)s and %(to)s
		  and pi.is_return = 0
		  {_INTERNAL_SUPPLIER_FILTER}
		  {sg_clause}
		""",
		params,
		as_dict=True,
	)
	purchases = flt(rows[0]["purchases"]) if rows else 0.0

	if ap_total is None:
		ap_total = _bns_ap_total(_run_payable_summary(company))
	ap = max(ap_total, 0.0)
	if purchases <= 0:
		return 0.0
	return round(ap / purchases * days, 0)


# ── STOCK ───────────────────────────────────────────────────────────────────

def _stock_by_item_group(company: str) -> list[dict]:
	"""Stock value grouped by Item.item_group."""
	rows = frappe.db.sql(
		"""
		select
			coalesce(i.item_group, 'Unclassified') as item_group,
			sum(b.actual_qty * b.valuation_rate) as stock_value,
			count(distinct b.item_code) as sku_count
		from `tabBin` b
		join `tabItem` i on i.name = b.item_code
		join `tabWarehouse` w on w.name = b.warehouse
		where w.company = %(company)s
		  and b.actual_qty > 0
		group by item_group
		order by stock_value desc
		""",
		{"company": company},
		as_dict=True,
	)
	return [
		{"item_group": r["item_group"], "stock_value": flt(r["stock_value"]), "sku_count": int(r["sku_count"])}
		for r in rows
	]


def _stock_warehouse_tree(company: str) -> list[dict]:
	"""Nested warehouse tree with stock values aggregated up from leaves."""
	warehouses = frappe.get_all(
		"Warehouse",
		filters={"company": company, "disabled": 0},
		fields=["name", "parent_warehouse", "is_group"],
		order_by="lft",
	)
	if not warehouses:
		return []

	wh_names = [w["name"] for w in warehouses]
	rows = frappe.db.sql(
		"""
		select b.warehouse,
			sum(b.actual_qty * b.valuation_rate) as stock_value,
			count(distinct b.item_code) as sku_count
		from `tabBin` b
		where b.warehouse in %(wh)s and b.actual_qty > 0
		group by b.warehouse
		""",
		{"wh": tuple(wh_names)},
		as_dict=True,
	)
	stock_map = {r["warehouse"]: (flt(r["stock_value"]), int(r["sku_count"])) for r in rows}

	node_map: dict[str, dict] = {}
	roots: list[dict] = []
	for w in warehouses:
		sv, sc = stock_map.get(w["name"], (0.0, 0))
		node = {
			"name": w["name"],
			"is_group": w["is_group"],
			"stock_value": sv,
			"sku_count": sc,
			"children": [],
		}
		node_map[w["name"]] = node
		parent = w["parent_warehouse"]
		if parent and parent in node_map:
			node_map[parent]["children"].append(node)
		else:
			roots.append(node)

	def _aggregate(node: dict) -> None:
		for child in node["children"]:
			_aggregate(child)
		if node["children"]:
			node["stock_value"] = sum(c["stock_value"] for c in node["children"])
			node["sku_count"] = sum(c["sku_count"] for c in node["children"])

	def _prune(nodes: list[dict]) -> list[dict]:
		out = []
		for n in nodes:
			n["children"] = _prune(n["children"])
			if n["stock_value"] > 0 or n["children"]:
				out.append(n)
		return out

	def _sort(nodes: list[dict]) -> list[dict]:
		nodes.sort(key=lambda n: n["stock_value"], reverse=True)
		for n in nodes:
			_sort(n["children"])
		return nodes

	for r in roots:
		_aggregate(r)
	return _sort(_prune(roots))


def _reorder_alerts(company: str, limit: int = 10) -> list[dict]:
	"""Items where actual_qty is below safety_stock or reorder_level."""
	rows = frappe.db.sql(
		"""
		select
			b.item_code,
			i.item_name,
			i.item_group,
			sum(b.actual_qty) as actual_qty,
			i.safety_stock,
			i.stock_uom
		from `tabBin` b
		join `tabItem` i on i.name = b.item_code
		join `tabWarehouse` w on w.name = b.warehouse
		where w.company = %(company)s
		  and i.safety_stock > 0
		group by b.item_code
		having actual_qty < i.safety_stock
		order by (i.safety_stock - actual_qty) desc
		limit %(limit)s
		""",
		{"company": company, "limit": limit},
		as_dict=True,
	)
	return [
		{
			"item_code": r["item_code"],
			"item_name": r["item_name"],
			"item_group": r["item_group"],
			"actual_qty": flt(r["actual_qty"]),
			"safety_stock": flt(r["safety_stock"]),
			"pct": round(flt(r["actual_qty"]) / flt(r["safety_stock"]) * 100, 0) if flt(r["safety_stock"]) else 0,
			"stock_uom": r["stock_uom"],
		}
		for r in rows
	]


def _dio(company: str, days: int = 365) -> float:
	"""Days Inventory Outstanding = (Stock Value / COGS) × Days."""
	ref = getdate(today())
	from_date = ref - timedelta(days=days)
	# COGS approximation: sum of incoming_rate × qty on delivered/sold items
	rows = frappe.db.sql(
		"""
		select coalesce(sum(sii.incoming_rate * sii.stock_qty), 0) as cogs
		from `tabSales Invoice Item` sii
		join `tabSales Invoice` si on si.name = sii.parent
		where si.docstatus = 1 and si.company = %(company)s
		  and si.posting_date between %(from)s and %(to)s
		  and si.is_return = 0
		""",
		{"company": company, "from": from_date, "to": ref},
		as_dict=True,
	)
	cogs = flt(rows[0]["cogs"]) if rows else 0.0
	# current stock value
	stock_rows = frappe.db.sql(
		"""
		select coalesce(sum(b.actual_qty * b.valuation_rate), 0) as val
		from `tabBin` b
		join `tabWarehouse` w on w.name = b.warehouse
		where w.company = %(company)s and b.actual_qty > 0
		""",
		{"company": company},
		as_dict=True,
	)
	stock_val = flt(stock_rows[0]["val"]) if stock_rows else 0.0
	if cogs <= 0:
		return 0.0
	return round(stock_val / cogs * days, 0)


# ── WHITELISTED ENDPOINTS (prepared-report cached) ────────────────────────

from company_dashboard.api.report_cache import get_or_compute as _cached


@frappe.whitelist()
def get_wc_overview() -> dict:
	_require_wc_access()
	return _cached("wc", "overview", _compute_wc_overview)


def _compute_wc_overview() -> dict:
	company = _default_company()

	bank_accounts = _bank_balance_per_account(company)
	total_bank = sum(a["balance"] for a in bank_accounts)

	ar_data = _run_receivable_summary(company)
	total_ar = _bns_ar_total(ar_data)

	ap_data = _run_payable_summary(company)
	total_ap = _bns_ap_total(ap_data)

	stock_rows = frappe.db.sql(
		"""
		select coalesce(sum(b.actual_qty * b.valuation_rate), 0) as val
		from `tabBin` b
		join `tabWarehouse` w on w.name = b.warehouse
		where w.company = %(company)s and b.actual_qty > 0
		""",
		{"company": company},
		as_dict=True,
	)
	total_stock = flt(stock_rows[0]["val"]) if stock_rows else 0.0

	nwc = total_bank + total_ar + total_stock - total_ap
	dso = _dso(company, ar_total=total_ar)
	dpo = _dpo(company, ap_total=total_ap)
	dio = _dio(company)
	ccc = dso + dio - dpo

	return {
		"company": company,
		"as_of": today(),
		"kpi": {
			"net_working_capital": nwc,
			"bank_balance": total_bank,
			"trade_receivable": total_ar,
			"trade_payable": total_ap,
			"stock_in_hand": total_stock,
			"ccc": ccc,
			"dso": dso,
			"dpo": dpo,
			"dio": dio,
		},
		"bank_account_count": len(bank_accounts),
	}


@frappe.whitelist()
def get_bank_detail() -> dict:
	_require_wc_access()
	return _cached("wc", "bank_detail", _compute_bank_detail)


def _compute_bank_detail() -> dict:
	company = _default_company()
	accounts = _bank_balance_per_account(company)
	total = sum(a["balance"] for a in accounts)
	trend = _bank_monthly_trend(company, months=6)
	burn = _cash_burn_rate(company)
	days_cash = round(total / burn * 30, 0) if burn > 0 else 999
	return {
		"company": company,
		"accounts": accounts,
		"total_balance": total,
		"account_count": len(accounts),
		"trend": trend,
		"cash_burn_monthly": burn,
		"days_cash_on_hand": days_cash,
	}


@frappe.whitelist()
def get_trade_receivable() -> dict:
	_require_wc_access()
	return _cached("wc", "trade_receivable", _compute_trade_receivable)


def _compute_trade_receivable() -> dict:
	company = _default_company()
	data = _run_receivable_summary(company)
	aging = _aggregate_aging(data)
	top = _top_parties(data, limit=10)
	dso = _dso(company)

	ref = getdate(today())
	month_start = ref.replace(day=1)
	collected = frappe.db.sql(
		"""
		select coalesce(sum(pe.paid_amount), 0) as collected
		from `tabPayment Entry` pe
		where pe.docstatus = 1 and pe.company = %(company)s
		  and pe.payment_type = 'Receive'
		  and pe.posting_date >= %(from)s
		  and pe.posting_date <= %(to)s
		""",
		{"company": company, "from": month_start, "to": ref},
		as_dict=True,
	)
	collected_amt = flt(collected[0]["collected"]) if collected else 0.0
	opening_ar = aging["total_outstanding"] + collected_amt
	collection_efficiency = round(collected_amt / opening_ar * 100, 0) if opening_ar > 0 else 0

	return {
		"company": company,
		"as_of": today(),
		"aging": aging,
		"top_debtors": top,
		"dso": dso,
		"collection_efficiency": collection_efficiency,
	}


@frappe.whitelist()
def get_trade_payable() -> dict:
	_require_wc_access()
	return _cached("wc", "trade_payable", _compute_trade_payable)


def _compute_trade_payable() -> dict:
	company = _default_company()
	data = _run_payable_summary(company)
	aging = _aggregate_aging(data)
	top = _top_parties(data, limit=10)
	dpo = _dpo(company)

	advance = frappe.db.sql(
		"""
		select coalesce(sum(unallocated_amount), 0) as advance
		from `tabPayment Entry`
		where docstatus = 1 and company = %(company)s
		  and payment_type = 'Pay'
		  and party_type = 'Supplier'
		  and unallocated_amount > 0
		""",
		{"company": company},
		as_dict=True,
	)
	advance_paid = flt(advance[0]["advance"]) if advance else 0.0

	return {
		"company": company,
		"as_of": today(),
		"aging": aging,
		"top_creditors": top,
		"dpo": dpo,
		"advance_paid": advance_paid,
	}


@frappe.whitelist()
def get_stock_detail() -> dict:
	_require_wc_access()
	return _cached("wc", "stock_detail", _compute_stock_detail)


def _compute_stock_detail() -> dict:
	company = _default_company()
	by_group = _stock_by_item_group(company)
	wh_tree = _stock_warehouse_tree(company)
	total_stock = sum(g["stock_value"] for g in by_group)
	reorder = _reorder_alerts(company)
	dio = _dio(company)

	def _count_leaves(nodes: list[dict]) -> int:
		return sum(1 if not n["is_group"] else _count_leaves(n["children"]) for n in nodes)

	return {
		"company": company,
		"total_stock_value": total_stock,
		"by_item_group": by_group,
		"warehouse_tree": wh_tree,
		"warehouse_count": _count_leaves(wh_tree),
		"reorder_alerts": reorder,
		"reorder_count": len(reorder),
		"dio": dio,
	}
