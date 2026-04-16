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
_CUSTOMER_GROUP_FIELDS = ("customer_segment_groups",)


class CompanyDashboardSettings(Document):
	def validate(self):
		for fieldname in _MULTISELECT_FIELDS:
			self._dedupe(fieldname, key="account")
		for fieldname in _CUSTOMER_GROUP_FIELDS:
			self._dedupe(fieldname, key="customer_group")

	def _dedupe(self, fieldname: str, key: str = "account") -> None:
		rows = self.get(fieldname) or []
		seen: set[str] = set()
		keep: list = []
		for r in rows:
			val = r.get(key)
			if val and val not in seen:
				seen.add(val)
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


def get_segment_root_map() -> dict[str, str]:
	"""Map every allowed Customer Group (and its NSM descendants) to the nearest
	admin-selected root from ``customer_segment_groups``.

	The /mis/segments page uses this to **fold sub-groups back into their selected
	parent**, so picking "Channel" shows one row named "Channel" with all its child
	channel groups' revenue rolled up — instead of one row per child.

	Empty dict when no scope is configured; callers treat that as "show every group".
	"""
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
	except frappe.DoesNotExistError:
		return {}
	rows = doc.get("customer_segment_groups") or []
	roots = [r.customer_group for r in rows if getattr(r, "customer_group", None)]
	if not roots:
		return {}
	root_map: dict[str, str] = {}
	for root in roots:
		if not frappe.db.exists("Customer Group", root):
			continue
		# NSM range walk in one SQL — handles any tree depth.
		descendants = frappe.db.sql(
			"""
			select cg.name
			from `tabCustomer Group` cg
			join `tabCustomer Group` parent on parent.name = %s
			where cg.lft >= parent.lft and cg.rgt <= parent.rgt
			""",
			(root,),
			pluck=True,
		)
		for name in descendants:
			# First-selected-root wins when two selected roots contain the same name
			# (should only happen if admin picks both an ancestor and its descendant).
			root_map.setdefault(name, root)
	return root_map


def get_allowed_customer_groups() -> list[str]:
	"""Flat list of allowed names for the WHERE-IN filter on /mis/segments. Empty when
	no scope is configured."""
	return sorted(get_segment_root_map().keys())


MIS_VIEWER_ROLE = "MIS Viewer"

# Default go-to-market channel records seeded as top-level Customer Groups on first
# install. Used by the SS & Distributor / Channel pages to bucket customers. Admins can
# later re-parent these or move them under a "Channel" parent group via Desk; the
# seeder only adds missing names — existing rows are never touched. Added here instead
# of Market Segment because Market Segment is conventionally for demographic / income
# buckets, not channels.
DEFAULT_CHANNEL_CUSTOMER_GROUPS = (
	"GT Distribution",
	"Modern Trade",
	"QuickCommerce",
	"Ecommerce",
	"Wholesale",
)
ROOT_CUSTOMER_GROUP = "All Customer Groups"


def ensure_mis_viewer_role() -> None:
	"""Idempotently create the read-only MIS Viewer role used to gate /mis access."""
	if frappe.db.exists("Role", MIS_VIEWER_ROLE):
		return
	role = frappe.new_doc("Role")
	role.role_name = MIS_VIEWER_ROLE
	role.desk_access = 1
	role.disabled = 0
	role.flags.ignore_permissions = True
	role.insert()


def ensure_channel_customer_groups() -> int:
	"""Insert default channel Customer Groups that don't already exist.

	Each new group is parented at the ``All Customer Groups`` root so admins can later
	move them under a custom parent (e.g. a "Channel" container group) without breaking
	the tree. Skipped if Customer Group isn't on this site or the root is missing.
	Returns the count of newly-created rows.
	"""
	if not frappe.db.table_exists("Customer Group"):
		return 0
	if not frappe.db.exists("Customer Group", ROOT_CUSTOMER_GROUP):
		# Site predates the standard ERPNext seed — bail out instead of guessing the root.
		return 0
	added = 0
	for name in DEFAULT_CHANNEL_CUSTOMER_GROUPS:
		if frappe.db.exists("Customer Group", name):
			continue
		doc = frappe.new_doc("Customer Group")
		doc.customer_group_name = name
		doc.parent_customer_group = ROOT_CUSTOMER_GROUP
		doc.is_group = 0
		doc.flags.ignore_permissions = True
		doc.insert()
		added += 1
	return added


def seed_defaults() -> dict:
	"""Populate the singleton with auto-discovered accounts for every multiselect.

	Idempotent: only fills fields that are currently empty, so re-running after the
	admin has customised any field won't clobber their choices. Called from
	``after_install`` and ``after_migrate``. Also ensures the ``MIS Viewer`` role
	exists so admins can grant dashboard-only access.
	"""
	ensure_mis_viewer_role()
	channel_groups_added = ensure_channel_customer_groups()
	doc = frappe.get_single("Company Dashboard Settings")
	added: dict[str, int] = {f: 0 for f in _MULTISELECT_FIELDS}
	added["channel_customer_groups"] = channel_groups_added

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
