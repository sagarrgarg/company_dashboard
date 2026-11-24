"""Tests for the Sales Invoices page (company_dashboard.api.invoices).

Rule tests use fixed numbers. Invariant tests read whatever invoices the test site has and
only assert relationships (list = dialog, flagged lines stay out of totals, cancelled
invoices never show), so they hold on any site; they skip when there is no data. Nothing
is written.
"""

import frappe
from frappe.utils import flt

try:  # Frappe v16+
	from frappe.tests import IntegrationTestCase as _TestCase
except ImportError:  # Frappe v15
	from frappe.tests.utils import FrappeTestCase as _TestCase

from company_dashboard.api import invoices as api

TOLERANCE = 0.01  # rupees
SAMPLE = 60  # recent invoices checked by the invariant tests


def _recent_invoices(limit=SAMPLE, **extra) -> list[str]:
	filters = {"docstatus": 1, **extra}
	return frappe.get_all(
		"Sales Invoice", filters=filters, pluck="name", order_by="posting_date desc", limit=limit
	)


class TestFlagRules(_TestCase):
	def test_high_cogs_needs_both_floor_and_ratio(self):
		self.assertEqual(api._flag_reason(600, 100, None), "high_cogs")
		self.assertIsNone(api._flag_reason(400, 10, None), "under ₹500 is never high_cogs")
		self.assertIsNone(api._flag_reason(600, 200, None), "3x revenue is plausible")

	def test_low_cogs_needs_a_reference(self):
		self.assertEqual(api._flag_reason(5, 700, 900), "low_cogs")
		self.assertIsNone(api._flag_reason(5, 700, None), "no BOM / purchase rate: no low flag")
		self.assertIsNone(api._flag_reason(100, 700, 900), "11% of reference is plausible")

	def test_implausible_reference_is_ignored(self):
		# A per-box purchase rate on a per-piece item: sale 95, real COGS 90, "rate" 1841.
		self.assertIsNone(api._flag_reason(90, 95, 1841))
		self.assertIsNone(api._flag_reason(1, 0, 200), "a free line is never low-flagged")

	def test_returns_compare_absolute_values(self):
		self.assertEqual(api._flag_reason(-5, -700, -900), "low_cogs")
		self.assertEqual(api._flag_reason(-600, -100, None), "high_cogs")

	def test_unknown_cogs_is_never_flagged(self):
		self.assertIsNone(api._flag_reason(None, 100, 900))

	def test_sql_flag_matches_python(self):
		cases = [
			(600, 100, None),
			(400, 10, None),
			(5, 700, 900),
			(100, 700, 900),
			(-5, -700, -900),
			(50, 700, None),
			(90, 95, 1841),
			(1, 0, 200),
		]
		for cogs, sale, ref in cases:
			sql = api._flag_sql("%(c)s", "%(s)s", "%(r)s")
			got = frappe.db.sql(f"select coalesce({sql}, 0)", {"c": cogs, "s": sale, "r": ref})[0][0]
			self.assertEqual(bool(got), api._flag_reason(cogs, sale, ref) is not None, (cogs, sale, ref))

	def test_bom_variance_sign(self):
		self.assertAlmostEqual(api._bom_variance(110, 100), 10)
		self.assertAlmostEqual(api._bom_variance(90, 100), -10)
		self.assertAlmostEqual(api._bom_variance(-110, -100), -10)
		self.assertIsNone(api._bom_variance(None, 100))
		self.assertIsNone(api._bom_variance(100, None))


class TestRanges(_TestCase):
	def test_custom_range_is_validated(self):
		company = frappe.db.get_single_value("Global Defaults", "default_company") or "x"
		with self.assertRaises(frappe.ValidationError):
			api._resolve_range(company, "custom", "2026-02-01", "2026-01-01")
		with self.assertRaises(frappe.ValidationError):
			api._resolve_range(company, "custom", "2020-01-01", "2026-01-01")
		with self.assertRaises(frappe.ValidationError):
			api._resolve_range(company, "custom", None, "2026-01-01")

	def test_unknown_range_falls_back_to_default(self):
		company = frappe.db.get_single_value("Global Defaults", "default_company") or "x"
		self.assertEqual(api._resolve_range(company, "bogus", None, None)[0], api.DEFAULT_RANGE)


class TestInvoiceInvariants(_TestCase):
	def setUp(self):
		frappe.set_user("Administrator")

	def test_list_and_dialog_agree(self):
		names = _recent_invoices()
		if not names:
			self.skipTest("no submitted Sales Invoices on this site")
		aggs = api._invoice_cogs(names)
		for name in names:
			d = api._invoice_detail(name, "excl")
			a = aggs[name]
			self.assertEqual(int(a.line_count), d["item_count"], name)
			self.assertEqual(int(a.flagged), d["lines_flagged"], name)
			self.assertEqual(int(a.missing), d["lines_without_cogs"], name)
			list_cogs = flt(a.cogs) if int(a.valued) else None
			if d["cogs_total"] is None:
				self.assertIsNone(list_cogs, name)
			else:
				self.assertAlmostEqual(list_cogs, d["cogs_total"], delta=TOLERANCE, msg=name)

	def test_totals_add_up_and_flagged_lines_stay_out(self):
		for name in _recent_invoices():
			d = api._invoice_detail(name, "excl")
			t, lines = d["totals"], d["lines"]
			self.assertAlmostEqual(sum(ln["amount"] for ln in lines), t["amount"], delta=TOLERANCE)
			counted = [ln for ln in lines if ln["cogs_amount"] is not None and not ln["flagged"]]
			if counted:
				self.assertAlmostEqual(
					sum(ln["cogs_amount"] for ln in counted), t["cogs"], delta=TOLERANCE, msg=name
				)
			else:
				self.assertIsNone(t["cogs"], name)
			for ln in lines:
				self.assertEqual(ln["flagged"], ln["flag_reason"] is not None)
				if ln["bom_variance_check"]:
					self.assertFalse(ln["flagged"], "a flagged line is never also a BOM check")
					self.assertGreater(abs(ln["bom_variance_pct"]), api.BOM_VARIANCE_CHECK_PCT)

	def test_bom_total_uses_only_compared_lines(self):
		for name in _recent_invoices():
			d = api._invoice_detail(name, "excl")
			b = d["totals"]["bom"]
			compared = [
				ln
				for ln in d["lines"]
				if ln["bom_variance_pct"] is not None and not ln["flagged"] and not ln["bom_variance_check"]
			]
			self.assertEqual(b["compared"], len(compared), name)
			if compared:
				self.assertAlmostEqual(
					b["planned"], sum(ln["bom_amount"] for ln in compared), delta=TOLERANCE
				)
				self.assertAlmostEqual(
					b["actual"], sum(ln["cogs_amount"] for ln in compared), delta=TOLERANCE
				)
			else:
				self.assertIsNone(b["planned"])

	def test_returns_use_booked_value_and_never_drift(self):
		names = _recent_invoices(limit=20, is_return=1)
		if not names:
			self.skipTest("no credit notes on this site")
		for name in names:
			for ln in api._invoice_detail(name, "excl")["lines"]:
				self.assertFalse(ln["cogs_drift"])
				if ln["cogs_amount"] is not None:
					self.assertEqual(ln["cogs_source"], "stock_ledger")
					self.assertAlmostEqual(ln["cogs_amount"], ln["booked_cogs_amount"], delta=TOLERANCE)

	def test_drafts_and_cancelled_are_refused(self):
		for status in (0, 2):
			name = frappe.db.get_value("Sales Invoice", {"docstatus": status}, "name")
			if name:
				with self.assertRaises(frappe.DoesNotExistError):
					api._invoice_detail(name, "excl")

	def test_cancelled_never_listed(self):
		cancelled = frappe.db.get_value("Sales Invoice", {"docstatus": 2}, ["name", "company"], as_dict=True)
		if not cancelled:
			self.skipTest("no cancelled Sales Invoices on this site")
		feed = api.get_invoice_feed(
			company=cancelled.company,
			range_key="custom",
			from_date="2024-01-01",
			to_date="2026-12-31",
			search=cancelled.name,
		)
		self.assertNotIn(cancelled.name, [r["name"] for r in feed["rows"]])

	def test_feed_pages_add_up(self):
		company = frappe.db.get_value("Sales Invoice", {"docstatus": 1}, "company")
		if not company:
			self.skipTest("no submitted Sales Invoices on this site")
		first = api.get_invoice_feed(company=company, range_key="30d", page_length=10)
		self.assertEqual(first["kpi"]["invoice_count"], first["total_count"])
		self.assertLessEqual(len(first["rows"]), 10)
		dates = [r["posted_at"] for r in first["rows"]]
		self.assertEqual(dates, sorted(dates, reverse=True), "newest first")


class TestAccess(_TestCase):
	def tearDown(self):
		frappe.set_user("Administrator")

	def test_guest_is_refused(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			api.get_invoice_feed()
		name = frappe.db.get_value("Sales Invoice", {"docstatus": 1}, "name")
		if name:
			with self.assertRaises(frappe.PermissionError):
				api.get_invoice_detail(name)
