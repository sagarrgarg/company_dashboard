/* Types mirror the JSON returned by company_dashboard.api.mis.* exactly.
 * Every *_pct margin is computed on tax-exclusive revenue and is `null` when that
 * revenue is below the ₹1,000 floor (data_quality.rules.min_revenue_for_pct). */

export type TaxMode = "incl" | "excl";

export type IntentFilter = "all" | "b2c" | "b2b";

/** Tiers that exist for every revenue bucket. */
type TierFields<P extends string> = {
	[K in
		| `${P}gross_profit`
		| `${P}cm1`
		| `${P}cm2`
		| `${P}cm3`
		| `${P}ebitda`
		| `${P}ebit`
		| `${P}pbt`
		| `${P}pat`]: number;
} & {
	[K in
		| `${P}gross_margin_pct`
		| `${P}gross_margin_coverage_pct`
		| `${P}cm1_pct`
		| `${P}cm2_pct`
		| `${P}cm3_pct`
		| `${P}ebitda_pct`
		| `${P}ebit_pct`
		| `${P}pbt_pct`
		| `${P}pat_pct`]: number | null;
};

export type KPI = TierFields<""> &
	TierFields<"b2c_"> &
	TierFields<"b2b_"> &
	TierFields<"unclassified_"> & {
		/** Revenue fields follow the selected tax mode (display only). */
		total_revenue: number;
		total_revenue_prior: number;
		b2c_revenue: number;
		b2c_revenue_prior: number;
		b2b_revenue: number;
		b2b_revenue_prior: number;
		unclassified_revenue: number;
		unclassified_revenue_prior: number;
		/** Tax-exclusive revenue — the base of every margin. */
		total_revenue_excl: number;
		b2c_revenue_excl: number;
		b2b_revenue_excl: number;
		unclassified_revenue_excl: number;
		/** False when the prior window is not fully covered by data. */
		prior_available: boolean;
		cogs: number;
		cogs_allocated: number;
		cogs_unallocated: number;
		direct_costs: number;
		other_expenses: number;
		other_income: number;
		/** Net expense of internal (inter-company) transfer accounts; can be negative. */
		internal_transfers: number;
		gl_net_profit: number;
		pat_residual: number;
		cm2_deduction: number;
		cm3_deduction: number;
		active_skus: number;
		avg_mrp: number | null;
	};

export interface PeriodPrior {
	from: string;
	to: string;
	/** True only when the prior window is fully covered by sales data. */
	available: boolean;
	coverage_pct: number;
	data_starts: string | null;
}

export interface PeriodInfo {
	from: string;
	to: string;
	label: string;
	kind: "ttm" | "fy" | "custom";
	days: number;
	is_12_months: boolean;
	last_month_partial: boolean;
	comparison_label: string;
	prior: PeriodPrior;
}

export interface Basis {
	revenue: TaxMode;
	margins: "excl";
}

export interface DataAnomaly {
	invoice: string;
	item_code: string;
	item_name: string;
	customer: string;
	month: string;
	qty: number;
	revenue: number;
	cost: number;
	unit_cost: number;
}

export interface DataWarning {
	code: string;
	bucket?: string;
	account?: string;
	message: string;
}

export interface DataQuality {
	coverage_pct: number;
	flagged_lines: number;
	flagged_cost: number;
	flagged_revenue: number;
	anomalies: DataAnomaly[];
	rules: {
		min_revenue_for_pct: number;
		min_cost: number;
		cost_to_revenue: number;
		unit_cost_to_median: number;
	};
	warnings: DataWarning[];
	unallocated_cogs?: number;
	pat_residual?: number;
}

/** Fields shared by every MIS response. */
interface MisEnvelope {
	period: PeriodInfo;
	company: string;
	tax_mode: TaxMode;
	basis: Basis;
	data_quality: DataQuality;
	refreshed_at?: string;
	stale?: boolean;
}

export interface MonthlyRevenuePoint {
	key: string; // "YYYY-MM"
	month: string; // "Apr"
	year: number;
	/** ₹ lakhs, selected tax mode. */
	b2c: number;
	b2b: number;
	other: number;
	total: number;
	/** Month-to-date, or a partial first month. */
	partial: boolean;
}

export interface CategorySlice {
	category: string;
	sku_count: number;
	/** ₹ lakhs. */
	revenue: number;
}

export type PnlStepKey =
	| "revenue"
	| "cogs"
	| "direct"
	| "cm1"
	| "freight"
	| "packaging"
	| "commission"
	| "scheme"
	| "cm2"
	| "marketing"
	| "cm3"
	| "salary"
	| "rent"
	| "utility"
	| "admin"
	| "other"
	| "internal"
	| "ebitda"
	| "da"
	| "ebit"
	| "interest"
	| "pbt"
	| "tax"
	| "pat";

export type PnlBucket = "overall" | "b2c" | "b2b" | "unclassified";

/** One ledger (or derived part) behind a P&L step. Deduction sources are signed as they
 *  move the line (+ adds cost, − is a credit netting it down) and sum to −step.amount;
 *  anchor (revenue) sources sum to step.amount. */
export interface PnlSource {
	/** GL account; null for a derived part (use `label`). */
	account: string | null;
	label?: string | null;
	amount: number;
	root_type?: string | null;
}

/** A tier's inputs: previous tier / revenue + the deductions in between (sum to the tier). */
export interface PnlComponent {
	key: PnlStepKey;
	label: string;
	amount: number;
}

export interface ApiPnlStep {
	key: PnlStepKey;
	label: string;
	kind: "anchor" | "deduction" | "tier";
	/** Deductions are negative. */
	amount: number;
	/** Running total after the step. */
	subtotal: number;
	/** amount ÷ ex-tax revenue × 100. */
	pct: number | null;
	note: string | null;
	group: "variable" | "operating" | null;
	/** How the figure is made, e.g. "CM1 − Freight − Packaging − …". */
	formula?: string;
	/** Ledgers behind the step (empty for tiers). */
	sources?: PnlSource[];
	/** Tiers only. */
	components?: PnlComponent[];
	/** Bucket revenue share (0–1); null for overall. */
	share?: number | null;
	bucket?: PnlBucket;
	/** Cost of goods only (overall): stock-ledger cost vs unallocated GL difference. */
	split?: { allocated: number; unallocated: number };
}

/** CM2 deductions: freight + packaging + transaction fees/commissions + schemes. */
export interface Cm2Inputs {
	freight_total: number;
	packaging_total: number;
	commission_total: number;
	scheme_total: number;
	variable_total: number;
	freight_accounts: string[];
	packaging_accounts: string[];
	commission_accounts: string[];
	scheme_accounts: string[];
	allocation_basis: string;
	company_scope: string;
}

/** CM3 deduction: marketing (online + offline). */
export interface Cm3Inputs {
	marketing_total: number;
	marketing_accounts: string[];
	allocation_basis: string;
	company_scope: string;
}

export interface AccountAmount {
	account: string;
	amount: number;
}

export interface LadderInputs {
	cogs_total: number;
	cogs_allocated: number;
	cogs_unallocated: number;
	cogs_accounts: AccountAmount[];
	direct_total: number;
	direct_accounts: string[];
	salary_total: number;
	rent_total: number;
	utility_total: number;
	admin_total: number;
	operating_total: number;
	other_expense_total: number;
	other_income_total: number;
	other_net_total: number;
	unmapped_expense_accounts: AccountAmount[];
	other_income_accounts: AccountAmount[];
	internal_total: number;
	internal_accounts: AccountAmount[];
	revenue_gl_difference: number | null;
	sales_gl: number | null;
	da_total: number;
	interest_total: number;
	tax_total: number;
	salary_accounts: string[];
	rent_accounts: string[];
	utility_accounts: string[];
	admin_accounts: string[];
	da_accounts: string[];
	interest_accounts: string[];
	tax_accounts: string[];
	gl_net_profit: number;
	allocation_basis: string;
	company_scope: string;
}

export interface OverviewResponse extends MisEnvelope {
	kpi: KPI;
	pnl: Record<PnlBucket, ApiPnlStep[]>;
	monthly: MonthlyRevenuePoint[];
	categories: CategorySlice[];
	cm2_inputs: Cm2Inputs;
	cm3_inputs: Cm3Inputs;
	ladder_inputs: LadderInputs;
	settings?: Record<string, unknown>;
	debug?: Record<string, unknown>;
}

/** Reporting period selected in the UI. "ttm" = backend default (last 12 months,
 *  current month to date). "fy" = named fiscal year. "custom" = arbitrary range. */
export type PeriodSelection =
	| { kind: "ttm" }
	| { kind: "fy"; name: string; from: string; to: string }
	| { kind: "custom"; from: string; to: string };

export interface FiscalYear {
	name: string;
	from: string;
	to: string;
}

export interface SkuRow {
	item_code: string;
	item_name: string;
	item_group: string;
	intent: string;
	is_stock_item: number;
	stock_uom: string;
	/** Selected tax mode. */
	revenue: number;
	revenue_excl: number;
	sold_revenue_excl: number;
	valued_revenue_excl: number;
	/** Stock-ledger cost, flagged lines excluded. */
	cogs: number;
	flagged_lines: number;
	flagged_cost: number;
	qty: number;
	/** ₹, selected tax mode, keyed "YYYY-MM". */
	monthly: Record<string, number>;
	/** Distinct invoices. */
	invoices: number;
	gp: number;
	gm_pct: number | null;
	cost_coverage_pct: number | null;
	alloc_freight: number;
	alloc_packaging: number;
	alloc_commission: number;
	alloc_scheme: number;
	alloc_marketing: number;
	alloc_variable: number;
	cm2: number;
	cm2_pct: number | null;
	cm3: number;
	cm3_pct: number | null;
}

export interface SkuAssortmentResponse extends MisEnvelope {
	intent: IntentFilter;
	month_keys: string[]; // "YYYY-MM"
	rows: SkuRow[];
	totals: {
		sku_count: number;
		revenue: number;
		revenue_excl: number;
		cogs: number;
		cogs_unallocated: number;
		direct_costs: number;
		/** Σ row gp − cogs_unallocated − direct_costs (= Overview CM1 when intent = all). */
		gp: number;
		gm_pct: number | null;
		qty_by_uom: Record<string, number>;
		flagged_lines: number;
		flagged_cost: number;
	};
	allocation: {
		basis: string;
		freight_pct: number;
		packaging_pct: number;
		commission_pct: number;
		scheme_pct: number;
		marketing_pct: number;
		variable_pct: number;
	};
}

export interface SegmentTopCustomer {
	customer: string;
	customer_name: string;
	revenue: number;
	invoices: number;
}

export interface SegmentTopCategory {
	category: string;
	sku_count: number;
	revenue: number;
}

export interface CustomerSegment {
	segment: string;
	revenue: number;
	revenue_excl: number;
	prior_revenue: number;
	yoy_pct: number | null;
	customers: number;
	invoices: number;
	aov: number | null;
	avg_customer_value: number | null;
	cogs: number;
	gp: number;
	gm_pct: number | null;
	gm_coverage_pct: number | null;
	/** ₹ lakhs, keyed "YYYY-MM". */
	monthly: Record<string, number>;
	top_customers: SegmentTopCustomer[];
	top_categories: SegmentTopCategory[];
}

export interface CustomerSegmentsResponse extends MisEnvelope {
	intent: IntentFilter;
	/** Admin-selected roots from settings. Descendant Customer Groups are rolled up
	 *  into their selected root before rendering — each root becomes one segment row. */
	scope_roots: string[];
	/** True when a customer-group scope or an intent filter applies. */
	is_scoped: boolean;
	month_keys: string[];
	segments: CustomerSegment[];
	totals: {
		revenue: number;
		revenue_excl: number;
		prior_revenue: number;
		customers: number;
		invoices: number;
		gp: number;
		gm_pct: number | null;
		cogs_unallocated: number;
		gp_after_unallocated: number;
		gm_pct_after_unallocated: number | null;
		segment_count: number;
		aov: number | null;
	};
}

/** company_dashboard.api.mis.get_ui_flags */
export interface UiFlags {
	coming_soon_tiles: Record<string, boolean>;
	sections: { mis: boolean; wc: boolean };
}
