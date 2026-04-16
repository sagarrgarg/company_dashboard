"""Singleton settings for the MIS dashboard.

Admin-editable cost account multi-selects power CM1 (and future CM2/CM3). Kept as
configuration rather than hardcoded so that a new freight / packaging account doesn't
require a code change — just tick it here.
"""

from __future__ import annotations

import frappe
from frappe.model.document import Document

# Candidate account name fragments we auto-seed on first install. Each tuple is
# (fieldname, include-fragments, exclude-fragments).
_SEED_MAP: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
	(
		"outbound_freight_accounts",
		(
			"courier",
			"delivery charge",
			"fba weight",
			"freight and forwarding",
			"freight charge",
			"shipping chargeback",
			"shipping fee",
			"transportation charge",
		),
		# inbound freight is part of COGS, not CM1.
		("inward", "inbound"),
	),
	("packaging_overhead_accounts", ("packing", "packaging"), ()),
	(
		"marketing_accounts",
		("marketing", "advertisement", "advertising", "ad spend", "business promotion", "promo"),
		("commission", "packing", "packaging"),  # exclude overlap with other buckets
	),
	(
		"marketplace_commission_accounts",
		(
			"commission",
			"marketplace fee",
			"platform fee",
			"amazon fee",
			"flipkart",
			"meesho",
			"ecom fee",
			"referral fee",
		),
		(),
	),
	(
		"trade_scheme_accounts",
		("scheme", "trade disc", "rebate", "distributor disc", "dealer disc"),
		(),
	),
	(
		"salary_accounts",
		(
			"salary",
			"salaries",
			"wage",
			"payroll",
			"staff welfare",
			"staff walfare",
			"epf",
			"esic",
			"pf employer",
			"provident fund",
			"gratuity",
			"bonus",
			"director's pay",
			"directors pay",
		),
		(
			# Exclude pure liability / advance-clearing accounts that aren't period cost.
			"payable",
			"advance",
		),
	),
	(
		"rent_accounts",
		("rent", "lease"),
		("rental income", "rent received"),
	),
	(
		"utility_accounts",
		(
			"electric",
			"power and fuel",
			"power & fuel",
			"water",
			"utility",
			"utilities",
			"internet",
			"telephone",
			"mobile",
			"broadband",
		),
		(),
	),
	(
		"admin_overhead_accounts",
		(
			"bank charge",
			"conveyance",
			"general & administrative",
			"general and administrative",
			"office exp",
			"office maintenance",
			"office supplies",
			"printing",
			"stationery",
			"legal",
			"professional",
			"audit",
			"insurance",
			"travel",
			"repair",
			"maintenance",
			"software",
			"subscription",
			"postage",
			"courier expense",
		),
		(
			# Exclude outbound courier (already in CM1 freight) and marketing-adjacent items.
			"freight",
			"courier exp",
			"shipping",
			"marketing",
			"advertis",
			"bank interest",  # interest portion goes to interest_and_finance_accounts
		),
	),
	(
		"depreciation_amortization_accounts",
		("depreciation", "depreciations", "amortization", "amortisation"),
		("accumulated", "provision for"),  # exclude Asset-side accumulated depreciation
	),
	(
		"interest_and_finance_accounts",
		(
			"interest on",
			"interest expense",
			"finance cost",
			"finance charge",
			"finance exp",
			"late fees & interest",
			"late fee",
			"loan processing",
			"bank interest",
		),
		(
			"interest income",
			"interest received",
			"tds on interest",
		),
	),
	(
		"tax_expense_accounts",
		(
			"income tax expense",
			"income tax paid",
			"tax expense",
			"deferred tax expense",
			"current tax",
			"mat ",
			"wealth tax",
		),
		(
			"refund",
			"receivable",
			"payable",
			"provision for",
			"tds",
			"gst",
			"vat",
			"service tax",
			"customs",
			"excise",
		),
	),
)

_MULTISELECT_FIELDS = tuple(f[0] for f in _SEED_MAP)


class CompanyDashboardSettings(Document):
	def validate(self):
		for fieldname in _MULTISELECT_FIELDS:
			self._dedupe(fieldname)

	def _dedupe(self, fieldname: str) -> None:
		rows = self.get(fieldname) or []
		seen: set[str] = set()
		keep: list = []
		for r in rows:
			acc = r.get("account")
			if acc and acc not in seen:
				seen.add(acc)
				keep.append(r)
		self.set(fieldname, keep)


def get_configured_accounts(fieldname: str) -> list[str]:
	"""Return the list of account names under a given multiselect, empty list if unset."""
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
	except frappe.DoesNotExistError:
		return []
	rows = doc.get(fieldname) or []
	return [r.account for r in rows if getattr(r, "account", None)]


def seed_defaults() -> dict:
	"""Populate the singleton with auto-discovered accounts for every multiselect.

	Idempotent: only fills fields that are currently empty, so re-running after the
	admin has customised any field won't clobber their choices. Called from
	``after_install`` and ``after_migrate``.
	"""
	doc = frappe.get_single("Company Dashboard Settings")
	added: dict[str, int] = {f: 0 for f in _MULTISELECT_FIELDS}

	for fieldname, include, exclude in _SEED_MAP:
		if doc.get(fieldname):
			continue
		# Cross-bucket dedupe: don't assign an account to CM2 buckets if it's already
		# sitting in a CM1 bucket (or earlier CM2 bucket). Keeps the deduction math
		# from double-counting a single account.
		already_assigned = {
			a for fn in _MULTISELECT_FIELDS for a in [r.account for r in (doc.get(fn) or [])]
		}
		for acc in _discover_accounts(include, exclude):
			if acc in already_assigned:
				continue
			doc.append(fieldname, {"account": acc})
			already_assigned.add(acc)
			added[fieldname] += 1

	if any(added.values()):
		doc.flags.ignore_permissions = True
		doc.save()

	return added


def _discover_accounts(include: tuple[str, ...], exclude: tuple[str, ...]) -> list[str]:
	"""Find active expense accounts matching hint fragments."""
	rows = frappe.get_all(
		"Account",
		filters={"is_group": 0, "disabled": 0, "root_type": "Expense"},
		fields=["name", "account_name"],
	)
	matches: list[str] = []
	for row in rows:
		raw = (row.get("account_name") or row["name"]).lower()
		if any(x in raw for x in exclude):
			continue
		if any(h in raw for h in include):
			matches.append(row["name"])
	return sorted(matches)
