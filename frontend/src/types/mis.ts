export interface KPI {
	total_revenue: number;
	total_revenue_prior: number;
	b2c_revenue: number;
	b2c_revenue_prior: number;
	b2b_revenue: number;
	b2b_revenue_prior: number;
	unclassified_revenue: number;
	gross_profit: number;
	gross_margin_pct: number;
	gross_margin_coverage_pct: number;
	b2c_gross_profit: number;
	b2c_gross_margin_pct: number;
	b2c_gross_margin_coverage_pct: number;
	b2b_gross_profit: number;
	b2b_gross_margin_pct: number;
	b2b_gross_margin_coverage_pct: number;
	/** CM1 ≡ Gross Margin. Aliased from gross_profit / gross_margin_pct. */
	cm1: number;
	cm1_pct: number;
	b2c_cm1: number;
	b2c_cm1_pct: number;
	b2b_cm1: number;
	b2b_cm1_pct: number;
	cm2: number;
	cm2_pct: number;
	cm2_deduction: number;
	b2c_cm2: number;
	b2c_cm2_pct: number;
	b2b_cm2: number;
	b2b_cm2_pct: number;
	cm3: number;
	cm3_pct: number;
	cm3_deduction: number;
	b2c_cm3: number;
	b2c_cm3_pct: number;
	b2b_cm3: number;
	b2b_cm3_pct: number;
	/** EBITDA = CM3 − fixed operating overhead (salary + rent + utilities + admin). */
	ebitda: number;
	ebitda_pct: number;
	b2c_ebitda: number;
	b2c_ebitda_pct: number;
	b2b_ebitda: number;
	b2b_ebitda_pct: number;
	/** EBIT = EBITDA − D&A. */
	ebit: number;
	ebit_pct: number;
	b2c_ebit: number;
	b2c_ebit_pct: number;
	b2b_ebit: number;
	b2b_ebit_pct: number;
	/** PBT and PAT. PBT = EBIT − interest. PAT = PBT − income-tax expense. */
	pbt: number;
	pbt_pct: number;
	pat: number;
	pat_pct: number;
	b2c_pat: number;
	b2c_pat_pct: number;
	b2b_pat: number;
	b2b_pat_pct: number;
	active_skus: number;
	avg_mrp: number;
}

export interface MonthlyRevenuePoint {
	month: string; // "Apr"
	year: number;
	b2c: number;
	b2b: number;
	other: number;
	total: number;
}

export interface CategorySlice {
	category: string;
	sku_count: number;
	revenue: number;
}

export type TaxMode = "incl" | "excl";

/** Reporting period. "ttm" = trailing-12-months (backend default).
 *  "fy" = named fiscal year (resolved from Frappe's Fiscal Year doctype).
 *  "custom" = arbitrary date range. */
export type PeriodSelection =
	| { kind: "ttm" }
	| { kind: "fy"; name: string; from: string; to: string }
	| { kind: "custom"; from: string; to: string };

export interface FiscalYear {
	name: string;
	from: string;
	to: string;
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

/** Below-CM3 ladder: EBITDA, EBIT, PBT, PAT deductions + the account lists behind each. */
export interface LadderInputs {
	salary_total: number;
	rent_total: number;
	utility_total: number;
	admin_total: number;
	operating_total: number;
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
	allocation_basis: string;
	company_scope: string;
}

export interface OverviewResponse {
	kpi: KPI;
	monthly: MonthlyRevenuePoint[];
	categories: CategorySlice[];
	period: { from: string; to: string; label: string };
	company: string;
	tax_mode: TaxMode;
	cm2_inputs: Cm2Inputs;
	cm3_inputs: Cm3Inputs;
	ladder_inputs: LadderInputs;
}
