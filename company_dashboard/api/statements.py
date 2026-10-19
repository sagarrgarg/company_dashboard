"""Balance sheet, cash flow and ratios — Schedule III (Division II) style, from the GL.

One classification drives all three: every balance-sheet account sits on exactly one
Schedule III line (admin override → definitive account type → the group it sits under →
root-type fallback, which is flagged). The cash flow is the movement of those same lines,
so it ties to balance-sheet cash by construction:

    Δ cash = PAT − Σ Δ(every other balance-sheet line, debit terms)

because every voucher balances. Period Closing Vouchers are left out of movements (they
only move P&L into equity, which PAT already counts) and opening entries count as
opening balances.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import date, timedelta

import frappe
from frappe import _
from frappe.utils import add_days, add_months, flt, getdate, today

from company_dashboard.api.finance import _overall_steps
from company_dashboard.api.mis import (
	_finance_book_clause,
	_period_dict,
	_period_for,
	_require_mis_access,
	_resolve_company,
	_sales_lines,
	_ttm_cache_anchor,
)
from company_dashboard.company_dashboard.doctype.company_dashboard_settings.company_dashboard_settings import (
	_bns_internal_accounts,
	get_configured_accounts,
)

# key, label, section, cash-flow section
BS_LINES: tuple[tuple[str, str, str, str], ...] = (
	("ppe", "Property, plant & equipment", "non_current_assets", "investing"),
	("cwip", "Capital work-in-progress", "non_current_assets", "investing"),
	("investments", "Non-current investments", "non_current_assets", "investing"),
	("other_non_current_assets", "Other non-current assets", "non_current_assets", "investing"),
	("inventories", "Inventories", "current_assets", "operating"),
	("trade_receivables", "Trade receivables", "current_assets", "operating"),
	("cash", "Cash & cash equivalents", "current_assets", "cash"),
	("other_current_assets", "Other current assets", "current_assets", "operating"),
	("internal_receivable", "Internal / inter-branch receivables", "current_assets", "operating"),
	("share_capital", "Share capital", "equity", "financing"),
	("other_equity", "Other equity", "equity", "financing"),
	("long_term_borrowings", "Long-term borrowings", "non_current_liabilities", "financing"),
	(
		"other_non_current_liabilities",
		"Other non-current liabilities",
		"non_current_liabilities",
		"operating",
	),
	("current_borrowings", "Current borrowings (OD / CC)", "current_liabilities", "financing"),
	("trade_payables", "Trade payables", "current_liabilities", "operating"),
	("other_current_liabilities", "Other current liabilities", "current_liabilities", "operating"),
	("provisions", "Provisions", "current_liabilities", "operating"),
	("internal_payable", "Internal / inter-branch payables", "current_liabilities", "operating"),
)
LINE = {k: {"key": k, "label": lbl, "section": sec, "cf": cf} for k, lbl, sec, cf in BS_LINES}
LABEL_TO_KEY = {lbl: k for k, lbl, _s, _c in BS_LINES}
SECTIONS = (
	("non_current_assets", "Non-current assets", "assets"),
	("current_assets", "Current assets", "assets"),
	("equity", "Equity", "equity_liabilities"),
	("non_current_liabilities", "Non-current liabilities", "equity_liabilities"),
	("current_liabilities", "Current liabilities", "equity_liabilities"),
)
SIDE = {sec: side for sec, _l, side in SECTIONS}

# Group-name hints, checked from the nearest parent upwards.
_GROUP_RULES: tuple[tuple[tuple[str, ...], str], ...] = (
	(("capital work",), "cwip"),
	(("share capital", "capital account", "owner", "partners capital", "proprietor"), "share_capital"),
	(("reserve", "surplus", "retained"), "other_equity"),
	(("accumulated depreciation", "fixed asset", "property, plant"), "ppe"),
	(("investment",), "investments"),
	(("secured loan", "unsecured loan", "loans (liabilities)", "borrowing", "term loan"), "_borrowings"),
	(("provision",), "provisions"),
	(("non-current asset", "non current asset"), "other_non_current_assets"),
	(("non-current liabilit", "non current liabilit"), "other_non_current_liabilities"),
	(("current asset",), "other_current_assets"),
	(("current liabilit", "duties and taxes"), "other_current_liabilities"),
)


def _internal_accounts() -> set[str]:
	return set(get_configured_accounts("wc_internal_accounts")) | set(_bns_internal_accounts())


def _overrides() -> list[tuple[str, str]]:
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
	except frappe.DoesNotExistError:
		return []
	return [
		(r.account, LABEL_TO_KEY[r.line])
		for r in (doc.get("statement_line_overrides") or [])
		if r.get("account") and r.get("line") in LABEL_TO_KEY
	]


def classify_accounts(company: str) -> dict[str, dict]:
	"""Balance-sheet leaf account → {line, rule, root_type, account_type}."""
	accounts = frappe.get_all(
		"Account",
		filters={"company": company, "root_type": ("in", ["Asset", "Liability", "Equity"])},
		fields=[
			"name",
			"account_name",
			"parent_account",
			"root_type",
			"account_type",
			"is_group",
			"lft",
			"rgt",
		],
	)
	by_name = {a.name: a for a in accounts}
	overrides = []
	for acc, line in _overrides():
		a = by_name.get(acc)
		if a:
			overrides.append((a.lft, a.rgt, acc, line))
	overrides.sort(key=lambda o: -o[0])  # deepest (most specific) first
	internal = _internal_accounts()

	def ancestors(a) -> list[str]:
		names, seen = [], set()
		cur = by_name.get(a.parent_account)
		while cur and cur.name not in seen:
			seen.add(cur.name)
			names.append((cur.account_name or cur.name).lower())
			cur = by_name.get(cur.parent_account)
		return names

	out: dict[str, dict] = {}
	for a in accounts:
		if a.is_group:
			continue
		line, rule = None, None
		for lft, rgt, acc, oline in overrides:
			if lft <= a.lft and a.rgt <= rgt:
				line, rule = oline, f"override: {acc}"
				break
		at, root = a.account_type or "", a.root_type
		if not line and a.name in internal and root in ("Asset", "Liability"):
			line, rule = (
				("internal_receivable" if root == "Asset" else "internal_payable"),
				"internal account",
			)
		if not line:
			by_type = {
				"Bank": "cash" if root == "Asset" else "current_borrowings",
				"Cash": "cash",
				"Receivable": "trade_receivables",
				"Payable": "trade_payables",
				"Stock": "inventories",
				"Fixed Asset": "ppe",
				"Accumulated Depreciation": "ppe",
				"Capital Work in Progress": "cwip",
				"Stock Received But Not Billed": "other_current_liabilities"
				if root != "Asset"
				else "other_current_assets",
				"Asset Received But Not Billed": "other_current_liabilities"
				if root != "Asset"
				else "other_current_assets",
				"Tax": "other_current_assets" if root == "Asset" else "other_current_liabilities",
				"Equity": "other_equity",
			}.get(at)
			if by_type:
				line, rule = by_type, f"account type: {at}"
		if not line:
			chain = [(a.account_name or a.name).lower(), *ancestors(a)]
			for name in chain:
				for hints, target in _GROUP_RULES:
					if any(h in name for h in hints):
						if target == "_borrowings":
							target = (
								"current_borrowings"
								if any("current liabilit" in n and "non" not in n for n in chain)
								else "long_term_borrowings"
							)
						line, rule = target, f"group: {name}"
						break
				if line:
					break
		if not line:
			line = {"Asset": "other_current_assets", "Liability": "other_current_liabilities"}.get(
				root, "other_equity"
			)
			rule = "fallback by root type"
		# An asset can't land on the equity & liabilities side or vice versa. (A Liability-
		# root account on an equity line is fine: Indian charts keep Capital Account there.)
		if (root == "Asset") != (SIDE[LINE[line]["section"]] == "assets"):
			fallback = {"Asset": "other_current_assets", "Liability": "other_current_liabilities"}.get(
				root, "other_equity"
			)
			rule = f"fallback by root type ({rule} conflicts with root {root})"
			line = fallback
		out[a.name] = {"line": line, "rule": rule, "root_type": root, "account_type": at}
	return out


def _balances_as_of(company: str, as_of: date, roots: tuple[str, ...]) -> dict[str, float]:
	"""Debit balance per leaf account up to and including ``as_of`` (all entries)."""
	params: dict = {"company": company, "as_of": as_of, "roots": roots}
	fb = _finance_book_clause(company, params)
	return {
		acc: flt(bal)
		for acc, bal in frappe.db.sql(
			f"""
			select ge.account, sum(ge.debit) - sum(ge.credit)
			from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
			where ge.company = %(company)s and ge.is_cancelled = 0 and ge.posting_date <= %(as_of)s
			  and a.root_type in %(roots)s {fb}
			group by ge.account
			""",
			params,
		)
	}


def _fy_bounds(company: str, d: date) -> tuple[date, date]:
	from erpnext.accounts.utils import get_fiscal_year

	try:
		fy = get_fiscal_year(d, company=company, as_dict=True)
		return getdate(fy.year_start_date), getdate(fy.year_end_date)
	except Exception:
		start = date(d.year if d.month >= 4 else d.year - 1, 4, 1)
		return start, date(start.year + 1, 3, 31)


def _pl_since(company: str, from_date: date, to_date: date) -> float:
	"""P&L (credit − debit) for a window, excluding Period Closing Vouchers."""
	params: dict = {"company": company, "from": from_date, "to": to_date}
	fb = _finance_book_clause(company, params)
	return -flt(
		frappe.db.sql(
			f"""
			select coalesce(sum(ge.debit) - sum(ge.credit), 0)
			from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
			where ge.company = %(company)s and ge.is_cancelled = 0
			  and ge.posting_date between %(from)s and %(to)s
			  and ge.voucher_type != 'Period Closing Voucher'
			  and a.root_type in ('Income', 'Expense') {fb}
			""",
			params,
		)[0][0]
	)


def _snapshot(company: str, as_of: date, classes: dict[str, dict]) -> dict:
	"""Balance sheet lines (side-signed: assets debit, equity & liabilities credit) as of a date."""
	bal = _balances_as_of(company, as_of, ("Asset", "Liability", "Equity"))
	pl_all = -sum(_balances_as_of(company, as_of, ("Income", "Expense")).values())
	fy_start, _fy_end = _fy_bounds(company, as_of)
	current_fy = _pl_since(company, fy_start, as_of)
	lines: dict[str, float] = defaultdict(float)
	accounts: dict[str, list] = defaultdict(list)
	for acc, b in bal.items():
		c = classes.get(acc)
		if not c:
			continue  # group or other-company account (shouldn't carry entries)
		key = c["line"]
		signed = b if SIDE[LINE[key]["section"]] == "assets" else -b
		lines[key] += signed
		if abs(b) >= 0.005:
			accounts[key].append({"account": acc, "amount": signed, "rule": c["rule"]})
	return {
		"lines": dict(lines),
		"accounts": {k: sorted(v, key=lambda x: -abs(x["amount"])) for k, v in accounts.items()},
		"provisional": {
			"total": pl_all,
			"current_fy": current_fy,
			"prior_unclosed": pl_all - current_fy,
			"fy_start": fy_start,
		},
		"trial_balance": sum(bal.values()) - pl_all,  # debit total − credit total over every account
	}


def _bs_totals(snap: dict) -> dict:
	sec = defaultdict(float)
	for key, val in snap["lines"].items():
		sec[LINE[key]["section"]] += val
	sec["equity"] += snap["provisional"]["total"]
	assets = sec["non_current_assets"] + sec["current_assets"]
	eq_li = sec["equity"] + sec["non_current_liabilities"] + sec["current_liabilities"]
	return {**sec, "assets": assets, "equity_liabilities": eq_li, "difference": assets - eq_li}


def _compute_balance_sheet(as_of: str | None = None, company: str | None = None) -> dict:
	company = _resolve_company(company)
	as_of_d = getdate(as_of or today())
	classes = classify_accounts(company)
	fy_start, _e = _fy_bounds(company, as_of_d)
	columns = [
		("as_of", as_of_d, as_of_d.strftime("%d %b %Y")),
		("prior_year", _shift_year(as_of_d), _shift_year(as_of_d).strftime("%d %b %Y")),
		("last_fy_close", add_days(fy_start, -1), "FY close " + add_days(fy_start, -1).strftime("%d %b %Y")),
	]
	snaps = {key: _snapshot(company, getdate(d), classes) for key, d, _l in columns}
	totals = {key: _bs_totals(s) for key, s in snaps.items()}
	now = snaps["as_of"]

	sections = []
	for sec_key, sec_label, side in SECTIONS:
		rows = []
		for key, label, sec, _cf in BS_LINES:
			if sec != sec_key:
				continue
			vals = {c: snaps[c]["lines"].get(key, 0.0) for c, _d, _l in columns}
			if not any(abs(v) >= 0.005 for v in vals.values()):
				continue
			rows.append(
				{
					"key": key,
					"label": label,
					"values": vals,
					"change": vals["as_of"] - vals["last_fy_close"],
					"accounts": now["accounts"].get(key, []),
					"cash_flow": LINE[key]["cf"],
				}
			)
		if sec_key == "equity":
			prov = {c: snaps[c]["provisional"] for c, _d, _l in columns}
			rows.append(
				{
					"key": "current_pl",
					"label": "Profit / loss not yet closed to reserves",
					"values": {c: prov[c]["total"] for c in prov},
					"change": prov["as_of"]["total"] - prov["last_fy_close"]["total"],
					"accounts": [
						{
							"account": None,
							"label": f"Current FY (from {now['provisional']['fy_start']})",
							"amount": now["provisional"]["current_fy"],
						},
						{
							"account": None,
							"label": "Earlier years not closed by a Period Closing Voucher",
							"amount": now["provisional"]["prior_unclosed"],
						},
					],
					"cash_flow": None,
				}
			)
		sections.append(
			{
				"key": sec_key,
				"label": sec_label,
				"side": side,
				"rows": rows,
				"totals": {c: totals[c][sec_key] for c, _d, _l in columns},
			}
		)

	bal_now = _balances_as_of(company, as_of_d, ("Asset", "Liability", "Equity"))
	fallback = [
		{"account": acc, "line": LINE[c["line"]]["label"], "rule": c["rule"], "balance": bal_now[acc]}
		for acc, c in classes.items()
		if c["rule"].startswith("fallback") and abs(bal_now.get(acc, 0.0)) >= 0.5
	]
	return {
		"company": company,
		"as_of": as_of_d.isoformat(),
		"columns": [{"key": k, "date": d.isoformat(), "label": lbl} for k, d, lbl in columns],
		"sections": sections,
		"totals": totals,
		"provisional": now["provisional"] | {"fy_start": now["provisional"]["fy_start"].isoformat()},
		"checks": {
			"balanced": abs(totals["as_of"]["difference"]) < 1,
			"difference": totals["as_of"]["difference"],
			"trial_balance_difference": now["trial_balance"],
			"prior_years_closed": abs(now["provisional"]["prior_unclosed"]) < 1,
			"fallback_accounts": fallback,
		},
	}


def _shift_year(d: date) -> date:
	shifted = getdate(add_months(d, -12))
	if d.day == calendar.monthrange(d.year, d.month)[1]:
		shifted = shifted.replace(day=calendar.monthrange(shifted.year, shifted.month)[1])
	return shifted


@frappe.whitelist()
def get_balance_sheet(as_of: str | None = None, company: str | None = None) -> dict:
	"""Schedule III balance sheet as of a date, with same-date-last-year and last FY close."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	as_of = (getdate(as_of) if as_of else getdate(today())).isoformat()
	kwargs = {"as_of": as_of, "company": company}
	return _cached(
		"mis",
		"balance_sheet",
		lambda: _compute_balance_sheet(**kwargs),
		kwargs,
		job=("company_dashboard.api.statements._compute_balance_sheet", kwargs),
	)


# ── Cash flow (indirect, Ind AS 7) ─────────────────────────────────────────


def _movements(company: str, from_date: date, to_date: date) -> dict[str, float]:
	"""Debit movement per balance-sheet account in the window, excluding Period Closing
	Vouchers and opening entries (those are part of the opening balance)."""
	params: dict = {"company": company, "from": from_date, "to": to_date}
	fb = _finance_book_clause(company, params)
	return {
		acc: flt(m)
		for acc, m in frappe.db.sql(
			f"""
			select ge.account, sum(ge.debit) - sum(ge.credit)
			from `tabGL Entry` ge join `tabAccount` a on a.name = ge.account
			where ge.company = %(company)s and ge.is_cancelled = 0
			  and ge.posting_date between %(from)s and %(to)s
			  and ge.voucher_type != 'Period Closing Voucher'
			  and coalesce(ge.is_opening, 'No') = 'No'
			  and a.root_type in ('Asset', 'Liability', 'Equity') {fb}
			group by ge.account
			""",
			params,
		)
	}


def _compute_cash_flow(
	from_date: str | None = None, to_date: str | None = None, company: str | None = None
) -> dict:
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	f, t = period.from_date, period.to_date
	classes = classify_accounts(company)
	moves = _movements(company, f, t)
	lines = _sales_lines(company, f, t)
	steps, pl = _overall_steps(company, lines, None, period)
	step = {s["key"]: s for s in steps}
	pat = step["pat"]["amount"]
	finance_cost = pl["totals"]["interest"]
	interest_income = sum(
		-r["amount"]
		for r in (pl.get("line_accounts") or {}).get("other", [])
		if r.get("account") and r.get("root_type") == "Income" and "interest" in r["account"].lower()
	)

	# Contribution of each line to cash = −Δ(debit balance).
	contrib: dict[str, float] = defaultdict(float)
	depreciation = 0.0
	detail: dict[str, list] = defaultdict(list)
	cash_accounts = []
	for acc, m in moves.items():
		c = classes.get(acc)
		if not c:
			continue
		if c["line"] == "cash":
			cash_accounts.append(acc)
			continue
		if c["account_type"] == "Accumulated Depreciation":
			depreciation += -m
			detail["depreciation"].append({"account": acc, "amount": -m})
			continue
		contrib[c["line"]] += -m
		if abs(m) >= 0.005:
			detail[c["line"]].append({"account": acc, "amount": -m})

	def items(section: str) -> list[dict]:
		out = []
		for key, label, _sec, cf in BS_LINES:
			if cf == section and abs(contrib.get(key, 0.0)) >= 0.005:
				verb = (
					"Decrease / (increase)"
					if LINE[key]["section"] in ("non_current_assets", "current_assets")
					else "Increase / (decrease)"
				)
				out.append(
					{
						"key": key,
						"label": f"{verb} in {label.lower()}" if section == "operating" else label,
						"amount": contrib[key],
						"accounts": sorted(detail[key], key=lambda x: -abs(x["amount"])),
					}
				)
		return out

	operating = [
		{"key": "pat", "label": "Profit after tax", "amount": pat, "accounts": []},
		{
			"key": "depreciation",
			"label": "Add: depreciation (accumulated depreciation movement)",
			"amount": depreciation,
			"accounts": detail["depreciation"],
		},
		{
			"key": "finance_cost",
			"label": "Add: finance cost (shown under financing)",
			"amount": finance_cost,
			"accounts": [],
		},
		{
			"key": "interest_income",
			"label": "Less: interest income (shown under investing)",
			"amount": -interest_income,
			"accounts": [],
		},
		*items("operating"),
	]
	investing = [
		*items("investing"),
		{"key": "interest_received", "label": "Interest received", "amount": interest_income, "accounts": []},
	]
	financing = [
		*items("financing"),
		{
			"key": "interest_paid",
			"label": "Interest & finance cost paid",
			"amount": -finance_cost,
			"accounts": [],
		},
	]
	operating = [r for r in operating if abs(r["amount"]) >= 0.005 or r["key"] == "pat"]
	investing = [r for r in investing if abs(r["amount"]) >= 0.005]
	financing = [r for r in financing if abs(r["amount"]) >= 0.005]

	cfo, cfi, cff = (sum(r["amount"] for r in sec) for sec in (operating, investing, financing))
	net = cfo + cfi + cff
	cash_leaf = [a for a, c in classes.items() if c["line"] == "cash"]
	opening_cash = _cash_balance(company, cash_leaf, f, opening=True)
	closing_cash = _cash_balance(company, cash_leaf, t, opening=False)
	return {
		"company": company,
		"period": _period_dict(period, company),
		"policy": {
			"od_treatment": "Overdraft / cash credit is a current borrowing (financing), not netted into cash.",
			"interest": "Ind AS 7: interest paid under financing, interest received under investing (accrual used as paid).",
		},
		"sections": [
			{
				"key": "operating",
				"label": "Cash flow from operating activities",
				"rows": operating,
				"total": cfo,
			},
			{
				"key": "investing",
				"label": "Cash flow from investing activities",
				"rows": investing,
				"total": cfi,
			},
			{
				"key": "financing",
				"label": "Cash flow from financing activities",
				"rows": financing,
				"total": cff,
			},
		],
		"net_change": net,
		"opening_cash": opening_cash,
		"closing_cash": closing_cash,
		"cash_accounts": cash_leaf,
		"checks": {
			"ties_to_balance_sheet": abs(opening_cash + net - closing_cash) < 1,
			"difference": opening_cash + net - closing_cash,
			"pat_equals_gl": abs(pat - pl["gl_net_profit"]) < 1,
		},
	}


def _cash_balance(company: str, accounts: list[str], d: date, opening: bool) -> float:
	"""Cash balance at the start (before ``d``, plus opening entries dated in the window)
	or at the end of ``d``."""
	if not accounts:
		return 0.0
	params: dict = {"company": company, "accounts": tuple(accounts), "d": d}
	fb = _finance_book_clause(company, params)
	cond = (
		"(ge.posting_date < %(d)s or (coalesce(ge.is_opening, 'No') = 'Yes' and ge.posting_date >= %(d)s))"
		if opening
		else "ge.posting_date <= %(d)s"
	)
	return flt(
		frappe.db.sql(
			f"""
			select coalesce(sum(ge.debit) - sum(ge.credit), 0) from `tabGL Entry` ge
			where ge.company = %(company)s and ge.is_cancelled = 0 and ge.account in %(accounts)s
			  and {cond} {fb}
			""",
			params,
		)[0][0]
	)


@frappe.whitelist()
def get_cash_flow(
	from_date: str | None = None, to_date: str | None = None, company: str | None = None
) -> dict:
	"""Indirect-method cash flow (Ind AS 7) that ties to balance-sheet cash."""
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	kwargs = {"from_date": from_date, "to_date": to_date, "company": company}
	return _cached(
		"mis",
		"cash_flow",
		lambda: _compute_cash_flow(**kwargs),
		{**kwargs, **_ttm_cache_anchor(from_date, to_date)},
		job=("company_dashboard.api.statements._compute_cash_flow", kwargs),
	)


# ── Ratios (Schedule III's eleven + a few) ─────────────────────────────────


def _ratio(key, label, formula, num, den, unit="x", higher_is_better=True) -> dict:
	value = (num / den) if den else None
	if value is not None and unit == "%":
		value *= 100
	return {
		"key": key,
		"label": label,
		"formula": formula,
		"numerator": num,
		"denominator": den,
		"value": value,
		"unit": unit,
		"higher_is_better": higher_is_better,
	}


def _ratio_set(company: str, f: date, t: date, classes: dict) -> list[dict]:
	open_s = _snapshot(company, add_days(f, -1), classes)
	close_s = _snapshot(company, t, classes)
	lines = _sales_lines(company, f, t)
	steps, pl = _overall_steps(company, lines, None, _period_for(f.isoformat(), t.isoformat()))
	st = {s["key"]: s["amount"] for s in steps}
	days = (t - f).days + 1
	ann = 365 / days if days > 0 else 1

	def L(snap, *keys):
		return sum(snap["lines"].get(k, 0.0) for k in keys)

	def avg(*keys):
		return (L(open_s, *keys) + L(close_s, *keys)) / 2

	def equity(snap):
		return L(snap, "share_capital", "other_equity") + snap["provisional"]["total"]

	ca_keys = ("inventories", "trade_receivables", "cash", "other_current_assets", "internal_receivable")
	cl_keys = (
		"current_borrowings",
		"trade_payables",
		"other_current_liabilities",
		"provisions",
		"internal_payable",
	)
	debt_keys = ("long_term_borrowings", "current_borrowings")
	ca, cl = L(close_s, *ca_keys), L(close_s, *cl_keys)
	debt, cash = L(close_s, *debt_keys), L(close_s, "cash")
	eq_close, eq_avg = equity(close_s), (equity(open_s) + equity(close_s)) / 2
	revenue, pat, ebit = st["revenue"], st["pat"], st["ebit"]
	ebitda, cogs = st["ebitda"], -st["cogs"]
	finance_cost = pl["totals"]["interest"]
	da = pl["totals"]["da"]
	repaid = max(0.0, L(open_s, "long_term_borrowings") - L(close_s, "long_term_borrowings"))

	from company_dashboard.api.wc import _net_credit_sales, _net_purchases

	sales = _net_credit_sales(company, t, days)
	purchases = _net_purchases(company, t, days)
	cap_avg = eq_avg + avg(*debt_keys)
	return [
		_ratio("current_ratio", "Current ratio", "Current assets ÷ current liabilities", ca, cl),
		_ratio(
			"quick_ratio",
			"Quick ratio",
			"(Current assets − inventories) ÷ current liabilities",
			ca - L(close_s, "inventories"),
			cl,
		),
		_ratio(
			"debt_equity",
			"Debt-equity",
			"(Long-term + current borrowings) ÷ total equity",
			debt,
			eq_close,
			higher_is_better=False,
		),
		_ratio(
			"dscr",
			"Debt service coverage",
			"(PAT + D&A + finance cost) ÷ (finance cost + long-term debt repaid)",
			pat + da + finance_cost,
			finance_cost + repaid,
		),
		_ratio("interest_coverage", "Interest coverage", "EBIT ÷ finance cost", ebit, finance_cost),
		_ratio(
			"net_debt_ebitda",
			"Net debt ÷ EBITDA",
			"(Borrowings − cash) ÷ EBITDA (annualised)",
			debt - cash,
			ebitda * ann,
			higher_is_better=False,
		),
		_ratio("roe", "Return on equity", "PAT (annualised) ÷ average equity", pat * ann, eq_avg, unit="%"),
		_ratio(
			"roce",
			"Return on capital employed",
			"EBIT (annualised) ÷ average (equity + borrowings)",
			ebit * ann,
			cap_avg,
			unit="%",
		),
		_ratio("net_profit_ratio", "Net profit ratio", "PAT ÷ revenue", pat, revenue, unit="%"),
		_ratio("gross_margin", "Gross margin", "CM1 ÷ revenue", st["cm1"], revenue, unit="%"),
		_ratio("ebitda_margin", "EBITDA margin", "EBITDA ÷ revenue", ebitda, revenue, unit="%"),
		_ratio(
			"inventory_turnover",
			"Inventory turnover",
			"Cost of goods (annualised) ÷ average inventories",
			cogs * ann,
			avg("inventories"),
		),
		_ratio(
			"receivables_turnover",
			"Trade receivables turnover",
			"Net credit sales incl. GST (annualised) ÷ average trade receivables",
			sales * ann,
			avg("trade_receivables"),
		),
		_ratio(
			"payables_turnover",
			"Trade payables turnover",
			"Net purchases incl. GST (annualised) ÷ average trade payables",
			purchases * ann,
			avg("trade_payables"),
		),
		_ratio(
			"net_capital_turnover",
			"Net capital turnover",
			"Revenue (annualised) ÷ average working capital (CA − CL)",
			revenue * ann,
			(ca - cl + L(open_s, *ca_keys) - L(open_s, *cl_keys)) / 2,
		),
	]


def _compute_ratios(
	from_date: str | None = None, to_date: str | None = None, company: str | None = None
) -> dict:
	company = _resolve_company(company)
	period = _period_for(from_date, to_date)
	classes = classify_accounts(company)
	current = _ratio_set(company, period.from_date, period.to_date, classes)
	info = _period_dict(period, company)
	prior = (
		{r["key"]: r for r in _ratio_set(company, period.prior_from, period.prior_to, classes)}
		if info["prior"]["available"]
		else {}
	)
	for r in current:
		p = prior.get(r["key"])
		r["prior"] = p["value"] if p else None
		if r["value"] is not None and r["prior"]:
			r["change_pct"] = (r["value"] - r["prior"]) / abs(r["prior"]) * 100
			r["flag_25pct"] = abs(r["change_pct"]) > 25  # Schedule III asks for a reason
		else:
			r["change_pct"], r["flag_25pct"] = None, False
	return {
		"company": company,
		"period": info,
		"annualised": (period.to_date - period.from_date).days + 1 < 360,
		"ratios": current,
	}


@frappe.whitelist()
def get_ratios(from_date: str | None = None, to_date: str | None = None, company: str | None = None) -> dict:
	_require_mis_access()
	from company_dashboard.api.report_cache import get_or_compute as _cached

	company = _resolve_company(company)
	kwargs = {"from_date": from_date, "to_date": to_date, "company": company}
	return _cached(
		"mis",
		"ratios",
		lambda: _compute_ratios(**kwargs),
		{**kwargs, **_ttm_cache_anchor(from_date, to_date)},
		job=("company_dashboard.api.statements._compute_ratios", kwargs),
	)
