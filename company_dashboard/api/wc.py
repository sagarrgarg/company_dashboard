"""Working Capital dashboard API.

Every headline figure ties to the GL as of the snapshot date:

- **Cash and bank** = asset-side Bank and Cash accounts. Overdraft / cash-credit accounts
  (Bank accounts under Liabilities) are **borrowings**, a separate line. Payment-gateway
  and marketplace clearing accounts are **gateway receivables**, not cash.
- **Trade receivable / payable** = GL balances of Receivable / Payable accounts, by party,
  excluding internal accounts, internal parties and admin-excluded groups. Advances (parties
  whose balance points the other way) are their own line; the trade figure is the net.
- **Stock** = GL Stock accounts. Bins (every bin, negatives included) are only used for
  the item-group / warehouse breakdown, with the bin-vs-GL gap shown.
- **Ageing** comes from the BNS Pure AR/AP reports (FIFO), run **once** per snapshot and
  scaled to the GL gross balance so buckets always add up to the headline.

All five panels come from one snapshot per company per day, computed under one lock.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, timedelta

import frappe
from frappe.utils import add_months, flt, getdate, today

from company_dashboard.api.mis import _require_wc_access, _resolve_company
from company_dashboard.api.report_cache import get_or_compute as _cached
from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
	get_configured_accounts,
	get_wc_exclude_customer_groups,
	get_wc_exclude_supplier_groups,
)

AGEING_RANGES = "30, 60, 90, 120"
TOP_PARTIES = 10
REORDER_LIST_LIMIT = 10


# ── helpers ─────────────────────────────────────────────────────────────────


def _default_company() -> str:
	return _resolve_company(None)


def _finance_book_clause(company: str, params: dict) -> str:
	fb = frappe.get_cached_value("Company", company, "default_finance_book")
	if fb:
		params["finance_book"] = fb
		return "and (coalesce(ge.finance_book, '') = '' or ge.finance_book = %(finance_book)s)"
	return "and coalesce(ge.finance_book, '') = ''"


def _internal_accounts() -> set[str]:
	return set(get_configured_accounts("wc_internal_accounts"))


def _leaf_accounts(
	company: str, account_types: tuple[str, ...], root_types: tuple[str, ...] | None = None
) -> list[frappe._dict]:
	filters: dict = {"company": company, "is_group": 0, "account_type": ("in", list(account_types))}
	if root_types:
		filters["root_type"] = ("in", list(root_types))
	return frappe.get_all(
		"Account", filters=filters, fields=["name", "account_name", "account_type", "root_type", "disabled"]
	)


def _balances(company: str, accounts: list[str], as_of: date) -> dict[str, float]:
	"""Debit − credit per account up to and including ``as_of``."""
	if not accounts:
		return {}
	params: dict = {"accounts": tuple(accounts), "company": company, "as_of": as_of}
	fb = _finance_book_clause(company, params)
	rows = frappe.db.sql(
		f"""
		select ge.account, sum(ge.debit) - sum(ge.credit) as bal, max(ge.posting_date) as last_posting_date
		from `tabGL Entry` ge
		where ge.account in %(accounts)s and ge.company = %(company)s
		  and ge.is_cancelled = 0 and ge.posting_date <= %(as_of)s
		  {fb}
		group by ge.account
		""",
		params,
		as_dict=True,
	)
	return {r.account: frappe._dict(bal=flt(r.bal), last=r.last_posting_date) for r in rows}


def _internal_parties(party_type: str) -> set[str]:
	doctype = "Customer" if party_type == "Customer" else "Supplier"
	std = "is_internal_customer" if party_type == "Customer" else "is_internal_supplier"
	bns = "is_bns_internal_customer" if party_type == "Customer" else "is_bns_internal_supplier"
	clauses = [f"coalesce({std}, 0) = 1"]
	if frappe.db.has_column(doctype, bns):
		clauses.append(f"coalesce({bns}, 0) = 1")
	return set(frappe.db.sql(f"select name from `tab{doctype}` where {' or '.join(clauses)}", pluck=True))


def _excluded_group_parties(party_type: str) -> set[str]:
	if party_type == "Customer":
		groups = get_wc_exclude_customer_groups()
		doctype, field = "Customer", "customer_group"
	else:
		groups = get_wc_exclude_supplier_groups()
		doctype, field = "Supplier", "supplier_group"
	if not groups:
		return set()
	return set(frappe.get_all(doctype, filters={field: ("in", groups)}, pluck="name"))


def _party_exclusions(party_type: str) -> set[str]:
	return _internal_parties(party_type) | _excluded_group_parties(party_type)


def _party_side(company: str, party_type: str, as_of: date) -> dict:
	"""Per-party GL balances on trade Receivable (Customer) or Payable (Supplier) accounts.
	Payables are returned positive (credit balance = owed). Rows for other party types on
	the same accounts (e.g. employees) stay in the total, keyed "<type>: <party>"."""
	account_type = "Receivable" if party_type == "Customer" else "Payable"
	sign = 1 if party_type == "Customer" else -1
	internal_accs = _internal_accounts()
	all_accounts = [a.name for a in _leaf_accounts(company, (account_type,))]
	trade_accounts = [a for a in all_accounts if a not in internal_accs]
	internal_accounts = [a for a in all_accounts if a in internal_accs]
	excluded = _party_exclusions(party_type)

	balances: dict[str, float] = {}
	excluded_total = 0.0
	if trade_accounts:
		params: dict = {"accounts": tuple(trade_accounts), "company": company, "as_of": as_of}
		fb = _finance_book_clause(company, params)
		for ptype, party, bal in frappe.db.sql(
			f"""
			select coalesce(ge.party_type, ''), coalesce(ge.party, ''), sum(ge.debit) - sum(ge.credit)
			from `tabGL Entry` ge
			where ge.account in %(accounts)s and ge.company = %(company)s
			  and ge.is_cancelled = 0 and ge.posting_date <= %(as_of)s
			  {fb}
			group by coalesce(ge.party_type, ''), coalesce(ge.party, '')
			""",
			params,
		):
			bal = sign * flt(bal)
			own_type = ptype in (party_type, "")
			if own_type and party and party in excluded:
				excluded_total += bal
				continue
			if abs(bal) >= 0.005:
				key = party if own_type else f"{ptype}: {party}"
				balances[key] = balances.get(key, 0.0) + bal

	internal = sum(sign * b.bal for b in _balances(company, internal_accounts, as_of).values())
	gross = sum(b for b in balances.values() if b > 0)
	advances = sum(b for b in balances.values() if b < 0)
	return {
		"balances": balances,
		"net": gross + advances,
		"gross": gross,
		# ≤ 0: parties whose net balance points the other way — money received / paid in
		# advance, as of the date, JV advances included. Measured on the net party balance,
		# not on unallocated Payment Ledger rows: BNS running-account (FIFO) books leave most
		# payments unallocated, so those rows would overstate advances many times over.
		"advances": advances,
		"excluded_parties_total": excluded_total,
		"internal_accounts_total": internal,
		"trade_accounts": trade_accounts,
		"internal_accounts": internal_accounts,
		# Control-account balances behind the net figure (side-signed). Excluded internal
		# parties are a separate line, so these add up to net + excluded_parties_total.
		"account_balances": [
			{"account": a, "amount": sign * b.bal}
			for a, b in sorted(
				_balances(company, trade_accounts, as_of).items(), key=lambda kv: -abs(kv[1].bal)
			)
		],
	}


# ── BANK AND CASH ───────────────────────────────────────────────────────────


def _bank_section(company: str, as_of: date) -> dict:
	gateways = set(get_configured_accounts("wc_gateway_accounts"))
	accounts = _leaf_accounts(company, ("Bank", "Cash"))
	known = {a.name for a in accounts}
	if gateways - known:
		accounts += frappe.get_all(
			"Account",
			filters={"name": ("in", list(gateways - known)), "company": company, "is_group": 0},
			fields=["name", "account_name", "account_type", "root_type", "disabled"],
		)
	bal = _balances(company, [a.name for a in accounts], as_of)

	rows = []
	for a in accounts:
		b = bal.get(a.name)
		if not b and a.disabled:
			continue
		if a.root_type == "Liability":
			kind = "borrowing"
		elif a.name in gateways:
			kind = "gateway"
		else:
			kind = "cash" if a.account_type == "Cash" else "bank"
		rows.append(
			{
				"account": a.name,
				"kind": kind,
				"balance": b.bal if b else 0.0,
				"last_posting_date": b.last.isoformat() if b and b.last else None,
			}
		)
	rows.sort(key=lambda r: (["bank", "cash", "gateway", "borrowing"].index(r["kind"]), -r["balance"]))

	def total(*kinds: str) -> float:
		return sum(r["balance"] for r in rows if r["kind"] in kinds)

	cash_accounts = [r["account"] for r in rows if r["kind"] in ("bank", "cash")]
	cash_and_bank = total("bank", "cash")
	# Burn counts cash, bank and OD/CC together, so moving money between them is not burn.
	burn = _cash_burn_rate(
		company, [r["account"] for r in rows if r["kind"] in ("bank", "cash", "borrowing")], as_of
	)
	return {
		"accounts": rows,
		"cash_and_bank": cash_and_bank,
		"bank_total": total("bank"),
		"cash_total": total("cash"),
		"gateway_receivables": total("gateway"),
		"borrowings": total("borrowing"),  # negative = drawn
		"trend": _cash_trend(company, cash_accounts, as_of),
		**burn,
		"days_cash_on_hand": (
			round(cash_and_bank / burn["cash_burn_monthly"] * 30, 0)
			if cash_and_bank > 0 and burn["cash_burn_monthly"] > 0
			else None
		),
	}


def _cash_trend(company: str, accounts: list[str], as_of: date, months: int = 6) -> list[dict]:
	"""Cash + bank balance at the start of each of the last N months, plus today — one
	GL pass with a conditional sum per point."""
	if not accounts:
		return []
	firsts = [getdate(add_months(as_of.replace(day=1), -i)) for i in range(months - 1, -1, -1)]
	params: dict = {"accounts": tuple(accounts), "company": company, "as_of": as_of}
	cols = []
	for i, first in enumerate(firsts):
		params[f"d{i}"] = first
		cols.append(f"coalesce(sum(case when ge.posting_date < %(d{i})s then ge.debit - ge.credit end), 0)")
	cols.append("coalesce(sum(ge.debit - ge.credit), 0)")
	fb = _finance_book_clause(company, params)
	row = frappe.db.sql(
		f"""
		select {", ".join(cols)}
		from `tabGL Entry` ge
		where ge.account in %(accounts)s and ge.company = %(company)s
		  and ge.is_cancelled = 0 and ge.posting_date <= %(as_of)s
		  {fb}
		""",
		params,
	)[0]
	points = [
		{
			"date": first.isoformat(),
			"month": first.strftime("%b"),
			"year": first.year,
			"balance": flt(row[i]),
			"is_today": False,
		}
		for i, first in enumerate(firsts)
	]
	points.append(
		{
			"date": as_of.isoformat(),
			"month": "Today",
			"year": as_of.year,
			"balance": flt(row[-1]),
			"is_today": True,
		}
	)
	return points


def _cash_burn_rate(company: str, accounts: list[str], as_of: date) -> dict:
	"""Average monthly net outflow over the trailing 3 months across all cash and bank
	accounts together, so transfers between them cancel out instead of counting as burn."""
	if not accounts:
		return {"cash_burn_monthly": 0.0, "net_inflow": False}
	params: dict = {
		"accounts": tuple(accounts),
		"company": company,
		"from": getdate(add_months(as_of, -3)),
		"to": as_of,
	}
	fb = _finance_book_clause(company, params)
	row = frappe.db.sql(
		f"""
		select coalesce(sum(ge.credit) - sum(ge.debit), 0)
		from `tabGL Entry` ge
		where ge.account in %(accounts)s and ge.company = %(company)s and ge.is_cancelled = 0
		  and ge.posting_date > %(from)s and ge.posting_date <= %(to)s
		  {fb}
		""",
		params,
	)
	outflow = flt(row[0][0]) / 3 if row else 0.0
	return {"cash_burn_monthly": max(outflow, 0.0), "net_inflow": outflow < 0}


# ── AGEING VIA BNS ─────────────────────────────────────────────────────────


@contextmanager
def _as_administrator():
	"""Run the BNS / ERPNext ageing report with full read access.

	Those reports read invoices through ``frappe.get_list``, which applies the caller's
	permissions, so a user who only has *WC Viewer* would get "Insufficient Permission
	for Purchase Invoice". The caller has already passed ``_require_wc_access`` and only
	receives aggregates. ``frappe.set_user`` overwrites the request's session id and
	form_dict, so both are restored exactly afterwards.
	"""
	local = frappe.local
	saved_session = frappe._dict(local.session)
	saved = {
		k: getattr(local, k, None)
		for k in (
			"form_dict",
			"role_permissions",
			"new_doc_templates",
			"user_perms",
			"jenv_restricted",
			"jenv_unrestricted",
		)
	}
	try:
		frappe.set_user("Administrator")
		yield
	finally:
		local.session.clear()
		local.session.update(saved_session)
		for k, v in saved.items():
			setattr(local, k, v)
		local.cache = {}


def _run_bns(party_type: str, company: str, as_of: date) -> list[dict]:
	"""BNS Pure AR/AP Summary (Party Link netting + FIFO ageing), run once per snapshot."""
	if party_type == "Customer":
		from business_needed_solutions.business_needed_solutions.report.pure_accounts_receivable_summary.pure_accounts_receivable_summary import (
			execute,
		)

		group_key, groups = "exclude_customer_group", get_wc_exclude_customer_groups()
	else:
		from business_needed_solutions.business_needed_solutions.report.pure_accounts_payable_summary.pure_accounts_payable_summary import (
			execute,
		)

		group_key, groups = "exclude_supplier_group", get_wc_exclude_supplier_groups()
	filters = frappe._dict(
		{
			"company": company,
			"report_date": as_of.isoformat(),
			"ageing_based_on": "Posting Date",
			"range": AGEING_RANGES,
			# Older ERPNext v15 releases read range1..range4 instead of ``range``.
			**{f"range{i + 1}": int(v) for i, v in enumerate(AGEING_RANGES.split(","))},
			"adjust_running_accounts": 1,
			"show_future_payments": 0,
			"show_gl_balance": 0,
			group_key: groups or [],
		}
	)
	with _as_administrator():
		_cols, data = execute(filters)
	excluded = _party_exclusions(party_type)
	return [row for row in data if row.get("party") not in excluded]


def _bucket_labels() -> list[str]:
	edges = [int(r.strip()) for r in AGEING_RANGES.split(",") if r.strip().isdigit()]
	labels, prev = [], 0
	for e in edges:
		labels.append(f"0 – {e} Days" if prev == 0 else f"{prev + 1} – {e} Days")
		prev = e
	labels.append(f"> {edges[-1]} Days")
	return labels


def _ageing(bns_rows: list[dict], gl_gross: float) -> dict:
	"""BNS FIFO ageing of positive balances, unscaled. Whatever the GL gross holds beyond
	that (balances BNS nets through Party Links, timing) is a separate reconciling bucket,
	so the buckets always add up to the headline without inflating any real bucket."""
	labels = _bucket_labels()
	n = len(labels)
	raw = [0.0] * n
	bns_total = 0.0
	for row in bns_rows:
		if flt(row.get("outstanding")) <= 0:
			continue
		bns_total += flt(row.get("outstanding"))
		for i in range(n):
			raw[i] += max(flt(row.get(f"range{i + 1}")), 0.0)

	def pct(x: float) -> float:
		return round(x / gl_gross * 100, 1) if gl_gross else 0.0

	buckets = [
		{"label": labels[i], "amount": raw[i], "pct": pct(raw[i]), "reconciling": False} for i in range(n)
	]
	diff = gl_gross - sum(raw)
	warning = None
	if abs(diff) >= 1:
		buckets.append(
			{
				"label": "Not aged by BNS (Party Link netting / timing)",
				"amount": diff,
				"pct": pct(diff),
				"reconciling": True,
			}
		)
		if gl_gross and abs(diff) / abs(gl_gross) > 0.05:
			warning = (
				f"BNS ageing covers {sum(raw) / gl_gross * 100:.0f}% of the GL balance; the rest is "
				"netted through Party Links or not yet aged."
			)
	return {
		"total_outstanding": gl_gross,
		"total_overdue": sum(raw[1:]),
		"buckets": buckets,
		"bns_total": bns_total,
		"warning": warning,
	}


def _age_by_party(bns_rows: list[dict]) -> dict[str, int]:
	"""Lower edge of the oldest non-zero bucket per party (0, 31, 61, 91, 121)."""
	edges = [0] + [int(r.strip()) + 1 for r in AGEING_RANGES.split(",") if r.strip().isdigit()]
	out: dict[str, int] = {}
	for row in bns_rows:
		for i in range(len(edges), 0, -1):
			if flt(row.get(f"range{i}")) > 0:
				out[row.get("party")] = edges[i - 1]
				break
	return out


def _top_parties(side: dict, bns_rows: list[dict], party_type: str) -> list[dict]:
	"""Top parties by GL balance, with age and status from the BNS ageing."""
	ages = _age_by_party(bns_rows)
	names_field = "customer_name" if party_type == "Customer" else "supplier_name"
	group_field = "customer_group" if party_type == "Customer" else "supplier_group"
	top = sorted(((p, b) for p, b in side["balances"].items() if b > 0), key=lambda pb: -pb[1])[:TOP_PARTIES]
	info = (
		{
			r.name: r
			for r in frappe.get_all(
				party_type,
				filters={"name": ("in", [p for p, _b in top if p])},
				fields=["name", f"{names_field} as party_name", f"{group_field} as party_group"],
			)
		}
		if top
		else {}
	)
	out = []
	for party, bal in top:
		age = ages.get(party, 0)
		meta = info.get(party) or frappe._dict()
		out.append(
			{
				"party": party or "(no party)",
				"party_name": meta.get("party_name") or party or "(no party)",
				"customer_group": meta.get("party_group") if party_type == "Customer" else "",
				"supplier_group": meta.get("party_group") if party_type == "Supplier" else "",
				"outstanding": bal,
				"age_days": age,
				"status": "Overdue" if age >= 61 else "Watch" if age >= 31 else "Current",
			}
		)
	return out


# ── RATIOS ─────────────────────────────────────────────────────────────────


def _net_credit_sales(company: str, as_of: date, days: int = 365) -> float:
	"""Invoiced sales incl. tax, net of returns, external, non-POS, over the window."""
	excluded = _party_exclusions("Customer")
	params: dict = {"company": company, "from": as_of - timedelta(days=days - 1), "to": as_of}
	clause = ""
	if excluded:
		params["excluded"] = tuple(excluded)
		clause = "and si.customer not in %(excluded)s"
	row = frappe.db.sql(
		f"""
		select coalesce(sum(si.base_grand_total), 0)
		from `tabSales Invoice` si
		where si.docstatus = 1 and si.company = %(company)s
		  and si.posting_date between %(from)s and %(to)s
		  and coalesce(si.is_pos, 0) = 0
		  and coalesce(si.is_opening, 'No') != 'Yes'
		  {clause}
		""",
		params,
	)
	return flt(row[0][0]) if row else 0.0


def _net_purchases(company: str, as_of: date, days: int = 365) -> float:
	"""Purchase invoices incl. tax, net of returns, external suppliers, over the window."""
	excluded = _party_exclusions("Supplier")
	params: dict = {"company": company, "from": as_of - timedelta(days=days - 1), "to": as_of}
	clause = ""
	if excluded:
		params["excluded"] = tuple(excluded)
		clause = "and pi.supplier not in %(excluded)s"
	row = frappe.db.sql(
		f"""
		select coalesce(sum(pi.base_grand_total), 0)
		from `tabPurchase Invoice` pi
		where pi.docstatus = 1 and pi.company = %(company)s
		  and pi.posting_date between %(from)s and %(to)s
		  and coalesce(pi.is_opening, 'No') != 'Yes'
		  {clause}
		""",
		params,
	)
	return flt(row[0][0]) if row else 0.0


def _gl_cogs(company: str, as_of: date, days: int = 365) -> float:
	"""GL cost of goods (Cost of Goods Sold accounts, internal ones excluded) for the window."""
	internal = _internal_accounts()
	accounts = [a.name for a in _leaf_accounts(company, ("Cost of Goods Sold",)) if a.name not in internal]
	if not accounts:
		return 0.0
	params: dict = {
		"accounts": tuple(accounts),
		"company": company,
		"from": as_of - timedelta(days=days - 1),
		"to": as_of,
	}
	fb = _finance_book_clause(company, params)
	row = frappe.db.sql(
		f"""
		select coalesce(sum(ge.debit) - sum(ge.credit), 0)
		from `tabGL Entry` ge
		where ge.account in %(accounts)s and ge.company = %(company)s and ge.is_cancelled = 0
		  and ge.posting_date between %(from)s and %(to)s
		  and ge.voucher_type != 'Period Closing Voucher'
		  {fb}
		""",
		params,
	)
	return flt(row[0][0]) if row else 0.0


def _days(numerator: float, denominator: float, days: int = 365) -> float | None:
	if denominator <= 0 or numerator < 0:
		return None
	return round(numerator / denominator * days, 0)


def _collection_efficiency(company: str, ar: dict, as_of: date) -> dict:
	"""Collections ÷ (opening receivable + this month's billing), from GL on trade
	receivable accounts (company currency), same party exclusions as the AR total."""
	month_start = as_of.replace(day=1)
	accounts = ar["trade_accounts"]
	billing = collections = movement = 0.0
	if accounts:
		excluded = _party_exclusions("Customer")
		params: dict = {"accounts": tuple(accounts), "company": company, "from": month_start, "to": as_of}
		clause = ""
		if excluded:
			params["excluded"] = tuple(excluded)
			clause = (
				"and not (coalesce(ge.party_type, '') in ('Customer', '') "
				"and coalesce(ge.party, '') in %(excluded)s)"
			)
		fb = _finance_book_clause(company, params)
		row = frappe.db.sql(
			f"""
			select
				coalesce(sum(case when ge.voucher_type = 'Sales Invoice' then ge.debit - ge.credit else 0 end), 0),
				coalesce(sum(case when ge.voucher_type in ('Payment Entry', 'Journal Entry') then ge.credit - ge.debit else 0 end), 0),
				coalesce(sum(ge.debit - ge.credit), 0)
			from `tabGL Entry` ge
			where ge.account in %(accounts)s and ge.company = %(company)s and ge.is_cancelled = 0
			  and ge.posting_date between %(from)s and %(to)s
			  {clause} {fb}
			""",
			params,
		)
		billing, collections, movement = flt(row[0][0]), flt(row[0][1]), flt(row[0][2])
	# Opening = today's net receivable less this month's movement on the same accounts and
	# parties — no second pass over the whole receivable history.
	opening = ar["net"] - movement
	base = opening + billing
	return {
		"collection_efficiency": round(collections / base * 100, 0) if base > 0 else None,
		"collections_mtd": collections,
		"billing_mtd": billing,
		"opening_receivable": opening,
	}


# ── STOCK ───────────────────────────────────────────────────────────────────


def _stock_section(company: str, as_of: date) -> dict:
	stock_accounts = [a.name for a in _leaf_accounts(company, ("Stock",), ("Asset",))]
	stock_bal = _balances(company, stock_accounts, as_of)
	gl_stock = sum(b.bal for b in stock_bal.values())

	bins = frappe.db.sql(
		"""
		select b.item_code, b.warehouse, b.actual_qty, b.stock_value, coalesce(i.item_group, 'Unclassified') as item_group
		from `tabBin` b
		join `tabWarehouse` w on w.name = b.warehouse
		left join `tabItem` i on i.name = b.item_code
		where w.company = %(company)s and (b.actual_qty != 0 or b.stock_value != 0)
		""",
		{"company": company},
		as_dict=True,
	)
	bin_total = sum(flt(b.stock_value) for b in bins)
	negative = [b for b in bins if flt(b.actual_qty) < 0]
	zero_qty_valued = [b for b in bins if flt(b.actual_qty) == 0 and flt(b.stock_value) != 0]

	groups: dict[str, dict] = {}
	for b in bins:
		g = groups.setdefault(b.item_group, {"item_group": b.item_group, "stock_value": 0.0, "_skus": set()})
		g["stock_value"] += flt(b.stock_value)
		g["_skus"].add(b.item_code)
	by_group = sorted(
		(
			{"item_group": g["item_group"], "stock_value": g["stock_value"], "sku_count": len(g["_skus"])}
			for g in groups.values()
		),
		key=lambda g: -g["stock_value"],
	)
	return {
		"stock_in_hand": gl_stock,
		"stock_accounts": stock_accounts,
		"stock_account_balances": [
			{"account": a, "amount": b.bal} for a, b in sorted(stock_bal.items(), key=lambda kv: -abs(kv[1].bal))
		],
		"bin_total": bin_total,
		"bin_vs_gl_gap": bin_total - gl_stock,
		"negative_bins": {"count": len(negative), "value": sum(flt(b.stock_value) for b in negative)},
		"zero_qty_valued_bins": {
			"count": len(zero_qty_valued),
			"value": sum(flt(b.stock_value) for b in zero_qty_valued),
		},
		"by_item_group": by_group,
		"warehouse_tree": _stock_warehouse_tree(company, bins),
	}


def _stock_warehouse_tree(company: str, bins: list) -> list[dict]:
	"""Nested warehouse tree with every bin's value (negatives included) rolled up."""
	warehouses = frappe.get_all(
		"Warehouse",
		filters={"company": company},
		fields=["name", "parent_warehouse", "is_group"],
		order_by="lft",
	)
	if not warehouses:
		return []
	stock_map: dict[str, list] = {}
	for b in bins:
		e = stock_map.setdefault(b.warehouse, [0.0, set()])
		e[0] += flt(b.stock_value)
		e[1].add(b.item_code)

	node_map: dict[str, dict] = {}
	roots: list[dict] = []
	for w in warehouses:
		sv, skus = stock_map.get(w["name"], (0.0, set()))
		node = {
			"name": w["name"],
			"is_group": bool(w["is_group"]),
			"stock_value": sv,
			"sku_count": len(skus),
			"_skus": set(skus),
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
			node["stock_value"] += child["stock_value"]
			node["_skus"] |= child["_skus"]
		node["sku_count"] = len(node["_skus"])

	def _prune(nodes: list[dict]) -> list[dict]:
		out = []
		for n in nodes:
			n["children"] = _prune(n["children"])
			if abs(n["stock_value"]) >= 0.005 or n["children"]:
				out.append(n)
		return out

	def _finish(nodes: list[dict]) -> list[dict]:
		nodes.sort(key=lambda n: n["stock_value"], reverse=True)
		for n in nodes:
			n.pop("_skus", None)
			_finish(n["children"])
		return nodes

	for r in roots:
		_aggregate(r)
	return _finish(_prune(roots))


def _reorder_alerts(company: str) -> list[dict]:
	"""Items below their warehouse reorder level (Item Reorder, projected qty — the rule
	ERPNext's auto-reorder uses) or below their company-wide safety stock (actual qty)."""
	alerts: dict[str, dict] = {}
	if frappe.db.table_exists("Item Reorder"):
		for r in frappe.db.sql(
			"""
			select ir.parent as item_code, i.item_name, i.item_group, i.stock_uom, ir.warehouse,
			       ir.warehouse_reorder_level as level, coalesce(b.actual_qty, 0) as actual_qty,
			       coalesce(b.projected_qty, 0) as projected_qty
			from `tabItem Reorder` ir
			join `tabItem` i on i.name = ir.parent and i.disabled = 0
			join `tabWarehouse` w on w.name = ir.warehouse and w.company = %(company)s
			left join `tabBin` b on b.item_code = ir.parent and b.warehouse = ir.warehouse
			where ir.parenttype = 'Item' and ir.warehouse_reorder_level > 0
			  and coalesce(b.projected_qty, 0) < ir.warehouse_reorder_level
			""",
			{"company": company},
			as_dict=True,
		):
			key = f"{r.item_code}|{r.warehouse}"
			alerts[key] = {
				"item_code": r.item_code,
				"item_name": r.item_name,
				"item_group": r.item_group,
				"warehouse": r.warehouse,
				"rule": "reorder_level",
				"actual_qty": flt(r.actual_qty),
				"projected_qty": flt(r.projected_qty),
				"safety_stock": flt(r.level),
				"pct": round(flt(r.projected_qty) / flt(r.level) * 100, 0) if flt(r.level) else 0,
				"stock_uom": r.stock_uom,
			}
	covered = {a["item_code"] for a in alerts.values()}
	for r in frappe.db.sql(
		"""
		select b.item_code, i.item_name, i.item_group, i.stock_uom, i.safety_stock, sum(b.actual_qty) as actual_qty
		from `tabBin` b
		join `tabItem` i on i.name = b.item_code and i.disabled = 0
		join `tabWarehouse` w on w.name = b.warehouse
		where w.company = %(company)s and i.safety_stock > 0
		group by b.item_code, i.item_name, i.item_group, i.stock_uom, i.safety_stock
		having actual_qty < i.safety_stock
		""",
		{"company": company},
		as_dict=True,
	):
		if r.item_code in covered:
			continue
		alerts[r.item_code] = {
			"item_code": r.item_code,
			"item_name": r.item_name,
			"item_group": r.item_group,
			"warehouse": None,
			"rule": "safety_stock",
			"actual_qty": flt(r.actual_qty),
			"projected_qty": None,
			"safety_stock": flt(r.safety_stock),
			"pct": round(flt(r.actual_qty) / flt(r.safety_stock) * 100, 0) if flt(r.safety_stock) else 0,
			"stock_uom": r.stock_uom,
		}
	return sorted(alerts.values(), key=lambda a: a["pct"])


# ── SNAPSHOT ────────────────────────────────────────────────────────────────


def _compute_wc_snapshot(company: str, as_of: date | str) -> dict:
	as_of = getdate(as_of)
	bank = _bank_section(company, as_of)
	ar = _party_side(company, "Customer", as_of)
	ap = _party_side(company, "Supplier", as_of)
	stock = _stock_section(company, as_of)
	bns_ar = _run_bns("Customer", company, as_of)
	bns_ap = _run_bns("Supplier", company, as_of)

	sales = _net_credit_sales(company, as_of)
	purchases = _net_purchases(company, as_of)
	cogs = _gl_cogs(company, as_of)
	dso = _days(max(ar["net"], 0.0), sales)
	dpo = _days(max(ap["net"], 0.0), purchases)
	dio = _days(stock["stock_in_hand"], cogs)
	ccc = (dso + dio - dpo) if None not in (dso, dio, dpo) else None

	trade_wc = ar["net"] + stock["stock_in_hand"] - ap["net"]
	ratios = {
		"dso": dso,
		"dpo": dpo,
		"dio": dio,
		"ccc": ccc,
		"net_credit_sales_365d": sales,
		"net_purchases_365d": purchases,
		"cogs_365d": cogs,
	}
	ce = _collection_efficiency(company, ar, as_of)
	reorder = _reorder_alerts(company)
	meta = {"company": company, "as_of": as_of.isoformat()}

	return {
		"overview": {
			**meta,
			"kpi": {
				"net_working_capital": trade_wc,
				"trade_working_capital": trade_wc,
				"working_capital_with_cash": trade_wc + bank["cash_and_bank"],
				"working_capital_net_of_borrowings": trade_wc + bank["cash_and_bank"] + bank["borrowings"],
				"bank_balance": bank["cash_and_bank"],
				"cash_and_bank": bank["cash_and_bank"],
				"borrowings": bank["borrowings"],
				"gateway_receivables": bank["gateway_receivables"],
				"trade_receivable": ar["net"],
				"receivable_gross": ar["gross"],
				"customer_advances": ar["advances"],
				"trade_payable": ap["net"],
				"payable_gross": ap["gross"],
				"supplier_advances": ap["advances"],
				"stock_in_hand": stock["stock_in_hand"],
				"internal_receivable": ar["internal_accounts_total"],
				"internal_payable": ap["internal_accounts_total"],
				**ratios,
			},
			"bank_account_count": len([a for a in bank["accounts"] if a["kind"] in ("bank", "cash")]),
		},
		"bank": {
			**meta,
			**bank,
			"total_balance": bank["cash_and_bank"],
			"account_count": len(bank["accounts"]),
		},
		"receivable": {
			**meta,
			"total": ar["net"],
			"gross": ar["gross"],
			"advances": ar["advances"],
			"internal_accounts_total": ar["internal_accounts_total"],
			"excluded_parties_total": ar["excluded_parties_total"],
			"account_balances": ar["account_balances"],
			"aging": _ageing(bns_ar, ar["gross"]),
			"top_debtors": _top_parties(ar, bns_ar, "Customer"),
			"dso": dso,
			"net_credit_sales_365d": sales,
			**ce,
		},
		"payable": {
			**meta,
			"total": ap["net"],
			"gross": ap["gross"],
			"advances": ap["advances"],
			"advance_paid": -ap["advances"],
			"internal_accounts_total": ap["internal_accounts_total"],
			"excluded_parties_total": ap["excluded_parties_total"],
			"account_balances": ap["account_balances"],
			"aging": _ageing(bns_ap, ap["gross"]),
			"top_creditors": _top_parties(ap, bns_ap, "Supplier"),
			"dpo": dpo,
			"net_purchases_365d": purchases,
		},
		"stock": {
			**meta,
			**stock,
			"total_stock_value": stock["stock_in_hand"],
			"warehouse_count": _count_leaves(stock["warehouse_tree"]),
			"reorder_alerts": reorder[:REORDER_LIST_LIMIT],
			"reorder_count": len(reorder),
			"dio": dio,
			"cogs_365d": cogs,
		},
	}


def _count_leaves(nodes: list[dict]) -> int:
	return sum(1 if not n["is_group"] else _count_leaves(n["children"]) for n in nodes)


def get_wc_snapshot(company: str | None = None) -> dict:
	"""Cached snapshot (one per company per day). Shared by every WC endpoint and export."""
	company = _resolve_company(company)
	as_of = getdate(today())
	return _cached(
		"wc",
		"snapshot",
		lambda: _compute_wc_snapshot(company, as_of),
		{"company": company, "as_of": as_of.isoformat()},
		job=(
			"company_dashboard.api.wc._compute_wc_snapshot",
			{"company": company, "as_of": as_of.isoformat()},
		),
	)


def _section(name: str, company: str | None) -> dict:
	_require_wc_access()
	snap = get_wc_snapshot(company)
	return {**snap[name], "refreshed_at": snap.get("refreshed_at"), "stale": snap.get("stale", False)}


# ── WHITELISTED ENDPOINTS ──────────────────────────────────────────────────


@frappe.whitelist()
def get_wc_overview(company: str | None = None) -> dict:
	return _section("overview", company)


@frappe.whitelist()
def get_bank_detail(company: str | None = None) -> dict:
	return _section("bank", company)


@frappe.whitelist()
def get_trade_receivable(company: str | None = None) -> dict:
	return _section("receivable", company)


@frappe.whitelist()
def get_trade_payable(company: str | None = None) -> dict:
	return _section("payable", company)


@frappe.whitelist()
def get_stock_detail(company: str | None = None) -> dict:
	return _section("stock", company)
