"""Regression tests for the bug-audit fixes.

The invariants here are the audit's acceptance test: PAT equals GL net profit, every
split adds up to its total, periods compare like for like, and amounts format the way
the screen shows them. They read whatever ledger data the test site has and only
assert relationships, so they hold on any site.
"""

from datetime import date

import frappe

try:  # Frappe v16+
	from frappe.tests import IntegrationTestCase as _TestCase
except ImportError:  # Frappe v15
	from frappe.tests.utils import FrappeTestCase as _TestCase

from company_dashboard.api import export, mis

TOLERANCE = 0.05  # ₹ — float sums over thousands of lines


class TestFormatting(_TestCase):
	def test_inr_rounds_before_choosing_the_unit(self):
		self.assertEqual(export._inr(99_95_000), "₹99.95 L")
		self.assertEqual(export._inr(99_99_600), "₹1.00 Cr")
		self.assertEqual(export._inr(99_999.6), "₹1.00 L")
		self.assertEqual(export._inr(12_345), "₹12,345")
		self.assertEqual(export._inr(-4_17_06_630), "−₹4.17 Cr")
		self.assertEqual(export._inr(1_23_45_67_89_012), "₹12,345.68 Cr")
		self.assertEqual(export._inr(float("inf")), "—")
		self.assertEqual(export._inr(None), "—")

	def test_indian_grouping(self):
		self.assertEqual(export._group_in(12345678), "1,23,45,678")
		self.assertEqual(export._group_in(999), "999")

	def test_pct_is_null_below_revenue_floor(self):
		self.assertIsNone(mis._pct(-500, 0))
		self.assertIsNone(mis._pct(100, mis.MIN_REVENUE_FOR_PCT - 1))
		self.assertAlmostEqual(mis._pct(50, 2000), 2.5)


class TestPeriods(_TestCase):
	def test_prior_window_is_same_dates_last_year(self):
		p = mis._build_period(date(2025, 4, 1), date(2026, 3, 31), "custom", "x")
		self.assertEqual((p.prior_from, p.prior_to), (date(2024, 4, 1), date(2025, 3, 31)))

	def test_month_end_stays_month_end_across_leap_years(self):
		self.assertEqual(mis._shift_year(date(2025, 2, 28), is_end=True), date(2024, 2, 29))
		self.assertEqual(mis._shift_year(date(2024, 2, 29), is_end=True), date(2023, 2, 28))

	def test_default_window_never_includes_future_days(self):
		p = mis._ttm_window(date(2026, 10, 20))
		self.assertEqual((p.from_date, p.to_date), (date(2025, 11, 1), date(2026, 10, 20)))


class TestLadder(_TestCase):
	def _pl(self, **totals):
		base = dict.fromkeys(mis.PL_KEYS, 0.0)
		base.update(totals)
		return {
			"totals": base,
			"accounts": {k: [] for k in mis.PL_KEYS},
			"cogs": 900.0,
			"unmapped_expense": 30.0,
			"other_income": 10.0,
		}

	def test_buckets_sum_to_overall_and_steps_end_at_pat(self):
		rev = {"overall": 1000.0, "b2c": 600.0, "b2b": 300.0, "unclassified": 100.0}
		line_cost = {"b2c": 400.0, "b2b": 250.0, "unclassified": 150.0}
		pl = self._pl(freight=20.0, salary=40.0, tax=5.0)
		ladder = mis._ladder(rev, line_cost, pl)
		for tier in ("cogs", "cm1", "cm2", "cm3", "ebitda", "pat"):
			total = sum(ladder[b][tier] for b in mis.BUCKETS)
			self.assertAlmostEqual(total, ladder["overall"][tier], places=6)
		# 1000 − 900 − 20 − 40 − (30 − 10) − 5
		self.assertAlmostEqual(ladder["overall"]["pat"], 15.0, places=6)
		steps = mis._pnl_steps(ladder["overall"], pl)
		self.assertAlmostEqual(steps[-1]["subtotal"], ladder["overall"]["pat"], places=6)


class TestReconcilesToLedger(_TestCase):
	"""Against the site's own data: totals tie to the GL and splits sum to totals."""

	def setUp(self):
		if not frappe.db.count("Company") or not mis._erpnext_installed():
			self.skipTest("needs a company with ERPNext data")
		self.company = mis._resolve_company()
		start = frappe.db.sql("select min(posting_date) from `tabGL Entry` where company=%s", self.company)[
			0
		][0]
		if not start:
			self.skipTest("no GL entries")
		self.from_date = start.isoformat()
		self.to_date = frappe.utils.today()

	def test_pat_equals_gl_net_profit(self):
		o = mis._compute_overview("excl", self.from_date, self.to_date, self.company)
		k = o["kpi"]
		self.assertAlmostEqual(k["pat"], k["gl_net_profit"], delta=TOLERANCE)
		self.assertAlmostEqual(o["pnl"]["overall"][-1]["subtotal"], k["pat"], delta=TOLERANCE)
		for tier in ("gross_profit", "cm3", "ebitda", "pat"):
			parts = sum(k[f"{b}_{tier}"] for b in mis.BUCKETS)
			self.assertAlmostEqual(parts, k[tier], delta=TOLERANCE, msg=tier)

	def test_sku_and_segment_views_tie_to_overview_cm1(self):
		o = mis._compute_overview("incl", self.from_date, self.to_date, self.company)
		s = mis._compute_sku_assortment("incl", self.from_date, self.to_date, "all", self.company)
		g = mis._compute_customer_segments("incl", self.from_date, self.to_date, "all", 10, 10, self.company)
		self.assertAlmostEqual(s["totals"]["gp"], o["kpi"]["gross_profit"], delta=TOLERANCE)
		self.assertAlmostEqual(s["totals"]["revenue_excl"], o["kpi"]["total_revenue_excl"], delta=TOLERANCE)
		if not g["is_scoped"]:
			self.assertAlmostEqual(
				g["totals"]["gp_after_unallocated"], o["kpi"]["gross_profit"], delta=TOLERANCE
			)

	def test_working_capital_ageing_adds_up(self):
		from company_dashboard.api import wc

		snap = wc._compute_wc_snapshot(self.company, frappe.utils.getdate())
		for side in ("receivable", "payable"):
			sec = snap[side]
			total = sum(b["amount"] for b in sec["aging"]["buckets"])
			self.assertAlmostEqual(total, sec["gross"], delta=TOLERANCE)
			self.assertAlmostEqual(sec["gross"] + sec["advances"], sec["total"], delta=TOLERANCE)
		k = snap["overview"]["kpi"]
		self.assertAlmostEqual(
			k["trade_working_capital"],
			k["trade_receivable"] + k["stock_in_hand"] - k["trade_payable"],
			delta=TOLERANCE,
		)
		borrowing = sum(a["balance"] for a in snap["bank"]["accounts"] if a["kind"] == "borrowing")
		self.assertAlmostEqual(k["borrowings"], borrowing, delta=TOLERANCE)
		cash = sum(a["balance"] for a in snap["bank"]["accounts"] if a["kind"] in ("bank", "cash"))
		self.assertAlmostEqual(k["cash_and_bank"], cash, delta=TOLERANCE)
