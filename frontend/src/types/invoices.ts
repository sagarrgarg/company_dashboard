/** Shapes returned by company_dashboard.api.invoices (see that module's docstring). */

export type InvoiceRange = "today" | "7d" | "30d" | "month" | "fy" | "custom";

export const INVOICE_RANGES: readonly InvoiceRange[] = ["today", "7d", "30d", "month", "fy", "custom"];

/** One row of the invoice list. Amounts are company currency; sale_total follows the tax
 *  mode, COGS and margin are always ex-tax. */
export interface InvoiceRow {
	name: string;
	posting_date: string;
	/** Server-local naive timestamp, "YYYY-MM-DDTHH:MM:SS". */
	posted_at: string;
	customer: string;
	customer_name: string;
	customer_group: string | null;
	is_return: 0 | 1;
	item_count: number;
	sale_total: number;
	net_total: number;
	/** Valued, unflagged lines only; null when there are none. */
	cogs_total: number | null;
	lines_without_cogs: number;
	/** Lines whose COGS is implausible (> 5x revenue, or < 10% of BOM cost) — left out of COGS and margin. */
	lines_flagged: number;
	margin_pct: number | null;
	/** Desk URL of the invoice. */
	url: string;
}

export interface InvoiceLine {
	idx: number;
	item_code: string;
	item_name: string;
	qty: number;
	uom: string;
	/** Per invoice UOM; follows the tax mode. */
	sale_rate: number;
	/** Per invoice UOM: incoming rate on a sale, booked stock value on a return; null = unknown. */
	cogs_rate: number | null;
	cogs_source: "invoice" | "delivery_note" | "stock_ledger" | null;
	/** Follows the tax mode. */
	amount: number;
	cogs_amount: number | null;
	/** Likely a valuation error, left out of the totals (see flag_reason). */
	flagged: boolean;
	/** high_cogs: COGS > 5x revenue; low_cogs: COGS under 10% of the BOM cost. */
	flag_reason: "high_cogs" | "low_cogs" | null;
	/** Rate-based, ex-tax. */
	margin_pct: number | null;
	/** Default BOM of the item (planned cost reference — never COGS); null = no BOM. */
	bom: string | null;
	/** Planned cost per invoice UOM, ex-tax. */
	bom_rate: number | null;
	bom_amount: number | null;
	/** Date the BOM was last saved (ERPNext's Update Cost doesn't change it). */
	bom_saved_on: string | null;
	/** What the low-COGS flag compared against: the BOM cost, else the last purchase rate. */
	ref_source: "bom" | "purchase" | null;
	/** That reference cost per invoice UOM, ex-tax. */
	ref_rate: number | null;
	/** Stock-ledger value booked for the line now (repost-aware); null = unknown. */
	booked_cogs_amount: number | null;
	/** Sale line whose booked value differs from the incoming-rate COGS (> 2% and ₹10) — usually a repost. */
	cogs_drift: boolean;
	/** (COGS - BOM) / |BOM| x 100; positive = cost more than planned. */
	bom_variance_pct: number | null;
	/** Unflagged line with a gap beyond ±50%: above = BOM likely outdated, below = stock likely under-valued. */
	bom_variance_check: boolean;
}

export interface InvoiceBomTotals {
	/** Lines with a BOM. */
	lines: number;
	/** Lines in the comparison (have COGS, not flagged, gap within ±50%). */
	compared: number;
	/** Lines left out because the gap is beyond ±50%. */
	check: number;
	planned: number | null;
	actual: number | null;
	variance: number | null;
	variance_pct: number | null;
}

export interface InvoiceTotals {
	qty: number;
	/** Sum of line amounts (follows the tax mode). */
	amount: number;
	cogs: number | null;
	/** Ex-tax, over the lines that have a COGS rate. */
	gross_profit: number | null;
	margin_pct: number | null;
	lines_without_cogs: number;
	lines_flagged: number;
	/** Lines with cogs_drift. */
	lines_drifted: number;
	net_total: number;
	taxes: number;
	discount: number;
	rounding: number;
	grand_total: number;
	/** BOM (planned) vs actual COGS over comparable lines. */
	bom: InvoiceBomTotals;
}

export interface InvoiceDetail extends InvoiceRow {
	company: string;
	return_against: string | null;
	lines: InvoiceLine[];
	totals: InvoiceTotals;
}

export interface InvoiceKpi {
	invoice_count: number;
	today_count: number;
	return_count: number;
	sales: number;
	cogs: number | null;
	margin_pct: number | null;
	line_count: number;
	lines_without_cogs: number;
	lines_flagged: number;
}

export interface InvoiceFeedResponse {
	company: string;
	tax_mode: "incl" | "excl";
	range: { key: InvoiceRange; from: string; to: string };
	server_time: string;
	/** Newest invoice of the company — ignores the list filters. */
	latest: InvoiceDetail | null;
	kpi: InvoiceKpi;
	rows: InvoiceRow[];
	total_count: number;
	start: number;
	page_length: number;
	filters: {
		customers: Array<{ value: string; label: string }>;
		customer_groups: string[];
		customers_truncated: boolean;
	};
	report_url: string;
}
