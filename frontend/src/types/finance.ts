/* Types mirror company_dashboard.api.finance.* exactly. Amounts are ₹ (ex-tax for the
 * P&L). `url`s are relative desk links (/app/...). */
import type { PeriodInfo, PnlStepKey, TaxMode } from "@/types/mis";

/* ── get_pnl_statement ──────────────────────────────────────────────────── */

export interface StatementMonth {
	key: string; // "YYYY-MM"
	label: string; // "Apr '25"
	partial: boolean;
	revenue: number;
}

export interface StatementRow {
	key: PnlStepKey;
	label: string;
	kind: "anchor" | "deduction" | "tier";
	group: "variable" | "operating" | null;
	formula: string;
	/** ₹ per month (deductions negative), keyed "YYYY-MM". */
	values: Record<string, number>;
	pct: Record<string, number | null>;
	total: number;
	total_pct: number | null;
	prior_total?: number | null;
	change?: number | null;
	change_pct?: number | null;
}

export interface PnlStatementResponse {
	period: PeriodInfo;
	company: string;
	tax_mode: TaxMode;
	basis?: { revenue: TaxMode; margins: "excl" };
	months: StatementMonth[];
	rows: StatementRow[];
	checks: {
		months_sum_to_total: boolean;
		pat_equals_gl: boolean;
		pat: number;
		gl_net_profit: number;
		max_drift?: number;
	};
	warnings?: Array<{ code?: string; message: string }>;
	refreshed_at?: string;
	stale?: boolean;
}

/* ── get_ledger_detail ──────────────────────────────────────────────────── */

export interface LedgerAccount {
	name: string;
	account_name: string;
	root_type: string;
	account_type: string | null;
	report_type: string;
	is_group: number;
	company?: string;
	parent_account?: string | null;
	/** Leaves rolled up (1 for a leaf account). */
	leaf_count: number;
	url: string;
	is_pl: boolean;
}

export interface LedgerVoucher {
	voucher_type: string;
	voucher_no: string;
	posting_date: string;
	party_type: string | null;
	party: string | null;
	against: string | null;
	remarks: string | null;
	debit: number;
	credit: number;
	net: number;
	url: string;
}

export type LedgerOrder = "amount" | "date";

export interface LedgerDetailResponse {
	company: string;
	account: LedgerAccount;
	from: string;
	to: string;
	opening: number;
	debit: number;
	credit: number;
	/** debit − credit in the window. */
	movement: number;
	closing: number;
	monthly: Array<{ key: string; net: number }>;
	vouchers: LedgerVoucher[];
	voucher_count: number;
	start: number;
	page_length: number;
	/** Desk General Ledger pre-filtered to this account and window. */
	gl_report_url: string;
}

/* ── get_revenue_detail ─────────────────────────────────────────────────── */

export interface RevenueInvoice {
	invoice: string;
	posting_date: string;
	customer: string;
	customer_name: string;
	is_return: number;
	line_count: number;
	/** Ex-tax, negative for returns. */
	revenue: number;
	url: string;
}

export interface RevenueDetailResponse {
	company: string;
	from: string;
	to: string;
	income_account: string | null;
	bucket: string | null;
	total: number;
	invoice_count: number;
	invoices: RevenueInvoice[];
	start: number;
	page_length: number;
	/** Desk Sales Register pre-filtered. */
	report_url: string;
}

/* ── Statements envelope ────────────────────────────────────────────────── */

interface StatementEnvelope {
	company: string;
	refreshed_at?: string;
	stale?: boolean;
}

/* ── get_balance_sheet ──────────────────────────────────────────────────── */

export type BsColumnKey = "as_of" | "prior_year" | "last_fy_close";

export interface BsColumn {
	key: BsColumnKey;
	date: string;
	label: string;
}

/** A classified account (amount side-signed: assets debit +, equity & liabilities credit +)
 *  — or a derived row (account null) such as the unclosed-P&L split. */
export type BsAccount =
	| { account: string; amount: number; rule: string; label?: undefined }
	| { account: null; label: string; amount: number; rule?: undefined };

export type CashFlowSectionKey = "operating" | "investing" | "financing";

export interface BsRow {
	key: string;
	label: string;
	values: Record<BsColumnKey, number>;
	/** as_of − last_fy_close. */
	change: number;
	/** Accounts behind the as-of value. */
	accounts: BsAccount[];
	/** Cash-flow section the line's movement lands in ("cash" for cash itself). */
	cash_flow: CashFlowSectionKey | "cash" | null;
}

export type BsSectionKey =
	| "non_current_assets"
	| "current_assets"
	| "equity"
	| "non_current_liabilities"
	| "current_liabilities";

export interface BsSection {
	key: BsSectionKey;
	label: string;
	side: "assets" | "equity_liabilities";
	rows: BsRow[];
	totals: Record<BsColumnKey, number>;
}

export type BsTotals = Record<BsSectionKey, number> & {
	assets: number;
	equity_liabilities: number;
	difference: number;
};

export interface BalanceSheetResponse extends StatementEnvelope {
	as_of: string;
	columns: BsColumn[];
	sections: BsSection[];
	totals: Record<BsColumnKey, BsTotals>;
	provisional: {
		total: number;
		current_fy: number;
		prior_unclosed: number;
		fy_start: string;
	};
	checks: {
		balanced: boolean;
		difference: number;
		trial_balance_difference: number;
		prior_years_closed: boolean;
		fallback_accounts: Array<{ account: string; line: string; rule: string; balance: number }>;
	};
}

/* ── get_cash_flow ──────────────────────────────────────────────────────── */

export interface CashFlowRow {
	key: string;
	label: string;
	amount: number;
	/** Balance movements behind the row (cash effect sign); empty for P&L-derived rows. */
	accounts: Array<{ account: string; amount: number }>;
}

export interface CashFlowSection {
	key: CashFlowSectionKey;
	label: string;
	rows: CashFlowRow[];
	total: number;
}

export interface CashFlowResponse extends StatementEnvelope {
	period: PeriodInfo;
	policy: { od_treatment: string; interest: string };
	sections: CashFlowSection[];
	net_change: number;
	opening_cash: number;
	closing_cash: number;
	cash_accounts: string[];
	checks: { ties_to_balance_sheet: boolean; difference: number; pat_equals_gl: boolean };
}

/* ── get_ratios ─────────────────────────────────────────────────────────── */

export interface Ratio {
	key: string;
	label: string;
	formula: string;
	numerator: number;
	denominator: number;
	value: number | null;
	unit: "x" | "%";
	higher_is_better: boolean;
	prior: number | null;
	change_pct: number | null;
	/** Schedule III: a change of more than 25% vs the prior year must be explained. */
	flag_25pct: boolean;
}

export interface RatiosResponse extends StatementEnvelope {
	period: PeriodInfo;
	annualised: boolean;
	ratios: Ratio[];
}

/* ── get_controls / get_alerts ──────────────────────────────────────────── */

export interface DeskLink {
	label: string;
	url: string;
}

export type ControlStatus = "pass" | "warn" | "fail" | "info";

export interface ControlCheck {
	key: string;
	group: string;
	label: string;
	status: ControlStatus;
	expected: number;
	actual: number;
	difference: number;
	detail: string;
	links: DeskLink[];
	bridge?: Array<{ label: string; amount: number; kind: "start" | "adjust" | "end" }>;
}

export interface ControlsResponse extends StatementEnvelope {
	period: PeriodInfo;
	summary: Record<ControlStatus, number>;
	/** Worst first. */
	checks: ControlCheck[];
}

export type AlertSeverity = "high" | "medium" | "low";

export interface AlertRow {
	label: string;
	amount: number | null;
	url: string;
	qty?: number;
	age?: number;
	count?: number;
}

export interface Alert {
	key: string;
	severity: AlertSeverity;
	label: string;
	count: number | null;
	amount: number | null;
	detail: string;
	links: DeskLink[];
	rows: AlertRow[];
}

export interface AlertsResponse extends StatementEnvelope {
	period: PeriodInfo;
	counts: Record<AlertSeverity, number>;
	alerts: Alert[];
}
