"""Singleton settings for the MIS dashboard.

Admin-editable cost account multi-selects power CM1 (and future CM2/CM3). Kept as
configuration rather than hardcoded so that a new freight / packaging account doesn't
require a code change — just tick it here.
"""

from __future__ import annotations

import json
import re

import frappe
from frappe import _
from frappe.model.document import Document

# Candidate account name fragments we auto-seed on first install. Each tuple is
# (fieldname, include-fragments, exclude-fragments).
_SEED_MAP: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
	(
		"direct_cost_accounts",
		(
			"direct overhead",
			"direct expense",
			"freight inward",
			"inward freight",
			"carriage inward",
			"job work",
			"jobwork",
			"labour charge",
			"manufacturing exp",
		),
		("outward", "outbound"),
	),
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
# Account buckets that existed before the ``seeded_fields`` flag. On an upgrade they are
# treated as already seeded, so migrate never re-fills one the admin emptied on purpose.
_LEGACY_SEEDED_FIELDS = tuple(f for f in _MULTISELECT_FIELDS if f != "direct_cost_accounts")
_CUSTOMER_GROUP_FIELDS = ("customer_segment_groups", "wc_exclude_customer_groups")
_SUPPLIER_GROUP_FIELDS = ("wc_exclude_supplier_groups",)
_EXTRA_ACCOUNT_FIELDS = ("sales_income_accounts", "wc_internal_accounts", "wc_gateway_accounts")
_ALL_ACCOUNT_FIELDS = _MULTISELECT_FIELDS + _EXTRA_ACCOUNT_FIELDS

# P&L buckets in ladder order. An account may sit in only one of them.
PL_BUCKET_FIELDS: tuple[str, ...] = (
	"direct_cost_accounts",
	"outbound_freight_accounts",
	"packaging_overhead_accounts",
	"marketplace_commission_accounts",
	"trade_scheme_accounts",
	"marketing_accounts",
	"salary_accounts",
	"rent_accounts",
	"utility_accounts",
	"admin_overhead_accounts",
	"depreciation_amortization_accounts",
	"interest_and_finance_accounts",
	"tax_expense_accounts",
)
# Buckets that may hold Income accounts too (netted against the expense). Only tax:
# a provision reversal is booked to an income account and must offset the expense.
PL_INCOME_ALLOWED_FIELDS = frozenset({"tax_expense_accounts"})
# These account types are always part of CM1 cost of goods — never a bucket.
COGS_ACCOUNT_TYPES = ("Cost of Goods Sold", "Stock Adjustment")

# Name fragments for payment-gateway / marketplace clearing accounts (matched on whole words).
_GATEWAY_HINTS = (
	"razorpay",
	"paytm",
	"pine labs",
	"pinelabs",
	"cred",
	"amazon",
	"phonepe",
	"gpay",
	"google pay",
	"payu",
	"cashfree",
	"ccavenue",
	"stripe",
	"paypal",
	"instamojo",
	"flipkart",
	"meesho",
	"gateway",
	"wallet",
	"juspay",
	"billdesk",
	"easebuzz",
	"mswipe",
	"bharatpe",
)

# Map the doctype Check fieldnames to the stable tile keys consumed by the SPA.
# Adding a new key here + a matching Check field in the JSON is all that's needed
# to expose another tile as toggleable.
COMING_SOON_FIELDS: dict[str, str] = {
	"ebitda": "coming_soon_ebitda",
	"ebit": "coming_soon_ebit",
	"pat": "coming_soon_pat",
	"gross_profit": "coming_soon_gross_profit",
	"active_skus": "coming_soon_active_skus",
	"unclassified_rev": "coming_soon_unclassified_rev",
	"operating_opex": "coming_soon_operating_opex",
	"interest_finance": "coming_soon_interest_finance",
	"income_tax": "coming_soon_income_tax",
}


class CompanyDashboardSettings(Document):
	def validate(self):
		for fieldname in _ALL_ACCOUNT_FIELDS:
			self._dedupe(fieldname, key="account")
		for fieldname in _CUSTOMER_GROUP_FIELDS:
			self._dedupe(fieldname, key="customer_group")
		for fieldname in _SUPPLIER_GROUP_FIELDS:
			self._dedupe(fieldname, key="supplier_group")
		self._validate_accounts()

	def _validate_accounts(self) -> None:
		"""Reject accounts that would silently distort the P&L.

		P&L buckets take leaf Expense accounts only (tax also takes Income, netted), and
		each account may sit in one bucket — otherwise it is deducted twice. Cost of
		Goods Sold / Stock Adjustment accounts are already in CM1. A group account would
		read 0 because GL entries never post to groups.
		"""
		names = {r.account for f in _ALL_ACCOUNT_FIELDS for r in (self.get(f) or []) if r.get("account")}
		if not names:
			return
		meta = {
			r.name: r
			for r in frappe.get_all(
				"Account",
				filters={"name": ("in", list(names))},
				fields=["name", "root_type", "is_group", "account_type"],
			)
		}
		errors: list[str] = []
		owner: dict[str, str] = {}

		def label(fieldname: str) -> str:
			return _(self.meta.get_label(fieldname))

		def check(fieldname: str, acc: str, root_types: tuple[str, ...]) -> None:
			row = meta.get(acc)
			if not row:
				errors.append(_("{0}: account {1} does not exist.").format(label(fieldname), acc))
			elif row.is_group:
				errors.append(_("{0}: {1} is a group account. Pick its leaf accounts instead.").format(label(fieldname), acc))
			elif row.root_type not in root_types:
				errors.append(
					_("{0}: {1} has root type {2}. This field accepts {3} accounts only.").format(
						label(fieldname), acc, row.root_type or _("(none)"), " / ".join(root_types)
					)
				)

		for fieldname in PL_BUCKET_FIELDS:
			roots = ("Expense", "Income") if fieldname in PL_INCOME_ALLOWED_FIELDS else ("Expense",)
			for r in self.get(fieldname) or []:
				acc = r.account
				check(fieldname, acc, roots)
				row = meta.get(acc)
				if row and row.account_type in COGS_ACCOUNT_TYPES:
					errors.append(
						_("{0}: {1} is a {2} account, which CM1 already includes. Remove it here.").format(
							label(fieldname), acc, row.account_type
						)
					)
				if acc in owner:
					errors.append(
						_("{0} is mapped in both {1} and {2}. An account may sit in one bucket only.").format(
							acc, label(owner[acc]), label(fieldname)
						)
					)
				else:
					owner[acc] = fieldname

		for r in self.get("sales_income_accounts") or []:
			check("sales_income_accounts", r.account, ("Income",))
			if r.account in owner:
				errors.append(
					_("{0} is both a Sales account and in {1}.").format(r.account, label(owner[r.account]))
				)
		for r in self.get("wc_gateway_accounts") or []:
			check("wc_gateway_accounts", r.account, ("Asset",))
		for r in self.get("wc_internal_accounts") or []:
			check("wc_internal_accounts", r.account, ("Asset", "Liability", "Expense", "Income"))

		if errors:
			frappe.throw("<br>".join(errors), title=_("Fix these account mappings"))

	def on_update(self):
		# The /bizdashboard SPA reads coming_soon_tiles (and sections) from the boot
		# payload, which Frappe caches per-user in redis under the "bootinfo" hash and
		# does NOT tie to this doctype. Without this, a saved toggle only takes effect
		# after a manual `bench clear-cache`. Drop the whole bootinfo hash so any user's
		# next dashboard load rebuilds boot with the new flags.
		frappe.cache.delete_value("bootinfo")

		# The MIS/WC pages themselves serve from a 24h prepared-report cache keyed only by
		# section+endpoint (see api/report_cache.py). Account-bucket mappings and the WC
		# customer/supplier exclusions edited here feed those computations directly, so a
		# save must also drop the prepared-report cache — otherwise the dashboards keep
		# showing pre-change CM/AR/AP figures until the 24h TTL lapses.
		from company_dashboard.api.report_cache import clear_section

		clear_section("mis")
		clear_section("wc")

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


def get_account_meta(names: list[str] | set[str] | tuple[str, ...]) -> dict[str, frappe._dict]:
	"""name -> {root_type, is_group, account_type, company} for the given accounts."""
	names = [n for n in set(names or []) if n]
	if not names:
		return {}
	return {
		r.name: r
		for r in frappe.get_all(
			"Account",
			filters={"name": ("in", names)},
			fields=["name", "root_type", "is_group", "account_type", "company"],
		)
	}


def get_mrp_price_list() -> str | None:
	"""Configured MRP price list, else one literally named 'MRP' if it exists."""
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
		configured = doc.get("mrp_price_list")
	except frappe.DoesNotExistError:
		configured = None
	if configured:
		return configured
	return "MRP" if frappe.db.exists("Price List", "MRP") else None


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


def get_wc_exclude_customer_groups() -> list[str]:
	"""Customer groups to exclude from WC Trade Receivable."""
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
	except frappe.DoesNotExistError:
		return []
	rows = doc.get("wc_exclude_customer_groups") or []
	return [r.customer_group for r in rows if getattr(r, "customer_group", None)]


def get_coming_soon_tiles() -> dict[str, bool]:
	"""Return a map of tile-key -> bool indicating which Overview tiles should render
	a ``Coming soon`` overlay instead of their computed value. Always returns the full
	key set so the SPA never has to check for missing keys."""
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
	except frappe.DoesNotExistError:
		return {k: False for k in COMING_SOON_FIELDS}
	return {tile: bool(doc.get(field)) for tile, field in COMING_SOON_FIELDS.items()}


def get_wc_exclude_supplier_groups() -> list[str]:
	"""Supplier groups to exclude from WC Trade Payable."""
	try:
		doc = frappe.get_cached_doc("Company Dashboard Settings", "Company Dashboard Settings")
	except frappe.DoesNotExistError:
		return []
	rows = doc.get("wc_exclude_supplier_groups") or []
	return [r.supplier_group for r in rows if getattr(r, "supplier_group", None)]


MIS_VIEWER_ROLE = "MIS Viewer"
WC_VIEWER_ROLE = "WC Viewer"

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


def ensure_wc_viewer_role() -> None:
	"""Idempotently create the WC Viewer role used to gate /bizdashboard/wc access."""
	if frappe.db.exists("Role", WC_VIEWER_ROLE):
		return
	role = frappe.new_doc("Role")
	role.role_name = WC_VIEWER_ROLE
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


def after_install() -> dict:
	"""Fresh install: seed every account field once."""
	return seed_defaults(fresh_install=True)


def seed_defaults(fresh_install: bool = False) -> dict:
	"""Populate the singleton with auto-discovered accounts for each account field.

	Each field is seeded **once**. ``seeded_fields`` remembers which fields were already
	filled (by us or the admin), so a later migrate never re-fills a bucket the admin
	emptied on purpose. On an upgrade from a version without that flag, the legacy
	buckets count as seeded (they were filled at install time); only new fields seed.
	Also ensures the viewer roles and default channel groups exist.
	"""
	ensure_mis_viewer_role()
	ensure_wc_viewer_role()
	channel_groups_added = ensure_channel_customer_groups()
	doc = frappe.get_single("Company Dashboard Settings")
	added: dict[str, int] = {f: 0 for f in _ALL_ACCOUNT_FIELDS}
	added["channel_customer_groups"] = channel_groups_added

	try:
		seeded = set(json.loads(doc.get("seeded_fields") or "[]"))
	except (TypeError, ValueError):
		seeded = set()
	if not seeded and not fresh_install:
		seeded = set(_LEGACY_SEEDED_FIELDS)
	before = set(seeded)

	# Cross-bucket dedupe: never put an account into a second bucket.
	already_assigned = {r.account for fn in _ALL_ACCOUNT_FIELDS for r in (doc.get(fn) or [])}

	def _fill(fieldname: str, candidates: list[str]) -> None:
		if fieldname in seeded:
			return
		seeded.add(fieldname)
		if doc.get(fieldname):
			return
		for acc in candidates:
			if acc in already_assigned:
				continue
			doc.append(fieldname, {"account": acc})
			already_assigned.add(acc)
			added[fieldname] += 1

	for fieldname, include, exclude in _SEED_MAP:
		_fill(fieldname, _discover_accounts(include, exclude))
	_fill("sales_income_accounts", _discover_sales_accounts())
	_fill("wc_internal_accounts", _discover_internal_accounts())
	_fill("wc_gateway_accounts", _discover_gateway_accounts())
	if not doc.get("mrp_price_list") and frappe.db.exists("Price List", "MRP"):
		doc.mrp_price_list = "MRP"

	if any(v for k, v in added.items() if k != "channel_customer_groups") or seeded != before:
		doc.seeded_fields = json.dumps(sorted(seeded))
		doc.flags.ignore_permissions = True
		# Seeded candidates come from name hints; a bad hint must not block migrate.
		doc.flags.ignore_validate = True
		doc.save()

	return added


def _discover_sales_accounts() -> list[str]:
	"""Each company's default income account, plus leaf income accounts used on Sales
	Invoices whose name says sales (returns included). Freight recovery, asset disposal,
	scrap and internal-transfer accounts are left out — they belong in Other income."""
	if not frappe.db.table_exists("Sales Invoice Item"):
		return []
	internal = set(_bns_internal_accounts())
	found = {
		a
		for a in frappe.get_all("Company", pluck="default_income_account")
		if a and a not in internal
	}
	used = frappe.db.sql(
		"""
		select distinct acc.name, acc.account_name
		from `tabSales Invoice Item` sii
		join `tabSales Invoice` si on si.name = sii.parent
		join `tabAccount` acc on acc.name = sii.income_account
		where si.docstatus = 1 and acc.root_type = 'Income' and acc.is_group = 0
		""",
		as_dict=True,
	)
	for row in used:
		raw = (row.account_name or row.name).lower()
		if row.name in internal or not re.search(r"\bsales?\b", raw):
			continue
		if any(x in raw for x in ("internal", "asset", "scrap", "freight", "transport", "interest")):
			continue
		found.add(row.name)
	return sorted(found)


def _bns_internal_accounts() -> list[str]:
	"""Internal-transfer accounts configured in BNS Branch Accounting Settings, if present."""
	doctype = "BNS Branch Accounting Settings"
	if not frappe.db.exists("DocType", doctype):
		return []
	fields = (
		"internal_branch_debtor_account",
		"internal_branch_creditor_account",
		"internal_sales_transfer_account",
		"internal_sales_non_gst_account",
		"internal_purchase_transfer_account",
		"internal_purchase_non_gst_account",
		"internal_transfer_account",
	)
	out = []
	for f in fields:
		try:
			val = frappe.db.get_single_value(doctype, f)
		except Exception:
			val = None
		if val:
			out.append(val)
	return out


def _discover_internal_accounts() -> list[str]:
	"""Internal debtor / creditor / COGS accounts: BNS-configured ones plus leaf receivable,
	payable and COGS accounts whose name says 'internal'."""
	found = {
		a
		for a in _bns_internal_accounts()
		if frappe.db.get_value("Account", a, "account_type") in ("Receivable", "Payable", "Cost of Goods Sold")
	}
	for row in frappe.get_all(
		"Account",
		filters={"is_group": 0, "account_type": ("in", ["Receivable", "Payable", "Cost of Goods Sold"])},
		fields=["name", "account_name"],
	):
		if re.search(r"\binternal\b", (row.account_name or row.name).lower()):
			found.add(row.name)
	return sorted(found)


def _discover_gateway_accounts() -> list[str]:
	"""Asset-side Bank accounts whose name matches a payment-gateway hint (whole words)."""
	pattern = re.compile(r"\b(" + "|".join(re.escape(h) for h in _GATEWAY_HINTS) + r")\b")
	return sorted(
		row.name
		for row in frappe.get_all(
			"Account",
			filters={"is_group": 0, "root_type": "Asset", "account_type": "Bank"},
			fields=["name", "account_name"],
		)
		if pattern.search((row.account_name or row.name).lower())
	)


def _discover_accounts(include: tuple[str, ...], exclude: tuple[str, ...]) -> list[str]:
	"""Find active leaf expense accounts matching hint fragments. Cost of Goods Sold and
	Stock Adjustment accounts are skipped — CM1 already includes them."""
	rows = [
		r
		for r in frappe.get_all(
			"Account",
			filters={"is_group": 0, "disabled": 0, "root_type": "Expense"},
			fields=["name", "account_name", "account_type"],
		)
		if r.account_type not in COGS_ACCOUNT_TYPES
	]
	matches: list[str] = []
	for row in rows:
		raw = (row.get("account_name") or row["name"]).lower()
		if any(x in raw for x in exclude):
			continue
		if any(h in raw for h in include):
			matches.append(row["name"])
	return sorted(matches)
