/* Types mirror company_dashboard.api.wc.* exactly. All five endpoints are served from
 * one snapshot (same refreshed_at / as_of). Day ratios are null when not meaningful. */

interface WcEnvelope {
	company: string;
	as_of: string;
	refreshed_at?: string;
	stale?: boolean;
}

export interface WcOverview extends WcEnvelope {
	kpi: {
		/** = trade working capital = AR + stock − AP (GL). */
		net_working_capital: number;
		trade_working_capital: number;
		working_capital_with_cash: number;
		working_capital_net_of_borrowings: number;
		/** = cash_and_bank (asset-side bank + cash only). */
		bank_balance: number;
		cash_and_bank: number;
		/** ≤ 0: OD / CC drawn. */
		borrowings: number;
		gateway_receivables: number;
		/** Net of customer advances. */
		trade_receivable: number;
		receivable_gross: number;
		/** ≤ 0 (net-credit customers). */
		customer_advances: number;
		/** Net of supplier advances. */
		trade_payable: number;
		payable_gross: number;
		/** ≤ 0 (net-debit suppliers). */
		supplier_advances: number;
		/** GL Stock In Hand. */
		stock_in_hand: number;
		internal_receivable: number;
		internal_payable: number;
		dso: number | null;
		dpo: number | null;
		dio: number | null;
		ccc: number | null;
		net_credit_sales_365d: number;
		net_purchases_365d: number;
		cogs_365d: number;
	};
	bank_account_count: number;
}

export type BankAccountKind = "bank" | "cash" | "gateway" | "borrowing";

export interface BankAccount {
	account: string;
	kind: BankAccountKind;
	balance: number;
	last_posting_date: string | null;
}

export interface BankTrendPoint {
	date: string;
	month: string;
	year: number;
	balance: number;
	is_today: boolean;
}

export interface BankDetail extends WcEnvelope {
	accounts: BankAccount[];
	cash_and_bank: number;
	bank_total: number;
	cash_total: number;
	gateway_receivables: number;
	borrowings: number;
	/** = cash_and_bank. */
	total_balance: number;
	account_count: number;
	/** Month-opening cash & bank balances; the last point is today. */
	trend: BankTrendPoint[];
	cash_burn_monthly: number;
	net_inflow: boolean;
	days_cash_on_hand: number | null;
}

export interface AgingBucket {
	label: string;
	/** Can be negative on the reconciling bucket. */
	amount: number;
	pct: number;
	/** Not an age bucket: the part of the GL gross BNS didn't age (e.g. Party Link netting). */
	reconciling?: boolean;
}

export interface AgingData {
	/** = gross outstanding. */
	total_outstanding: number;
	total_overdue: number;
	/** Unscaled; a final `reconciling` bucket makes them sum to the GL gross. */
	buckets: AgingBucket[];
	bns_total: number;
	warning?: string | null;
}

export interface PartyRow {
	party: string;
	party_name: string;
	customer_group: string | null;
	supplier_group: string | null;
	outstanding: number;
	age_days: number | null;
	status: "Current" | "Watch" | "Overdue";
}

export interface TradeReceivable extends WcEnvelope {
	/** Net receivable (gross + advances), ties to GL. */
	total: number;
	gross: number;
	/** ≤ 0. */
	advances: number;
	internal_accounts_total: number;
	excluded_parties_total: number;
	aging: AgingData;
	top_debtors: PartyRow[];
	dso: number | null;
	net_credit_sales_365d: number;
	collection_efficiency: number | null;
	collections_mtd: number;
	billing_mtd: number;
	opening_receivable: number;
}

export interface TradePayable extends WcEnvelope {
	total: number;
	gross: number;
	/** ≤ 0. */
	advances: number;
	/** = −advances (positive): suppliers with a net debit balance. */
	advance_paid: number;
	internal_accounts_total: number;
	excluded_parties_total: number;
	aging: AgingData;
	top_creditors: PartyRow[];
	dpo: number | null;
	net_purchases_365d: number;
}

export interface StockGroup {
	item_group: string;
	/** Can be negative (negative bins are included). */
	stock_value: number;
	sku_count: number;
}

export interface ReorderAlert {
	item_code: string;
	item_name: string;
	item_group: string;
	warehouse: string | null;
	rule: "reorder_level" | "safety_stock";
	actual_qty: number;
	projected_qty: number | null;
	safety_stock: number;
	pct: number;
	stock_uom: string;
}

export interface WarehouseTreeNode {
	name: string;
	is_group: boolean;
	stock_value: number;
	sku_count: number;
	children: WarehouseTreeNode[];
}

export interface StockDetail extends WcEnvelope {
	/** GL Stock In Hand. */
	stock_in_hand: number;
	stock_accounts: string[];
	bin_total: number;
	bin_vs_gl_gap: number;
	negative_bins: { count: number; value: number };
	zero_qty_valued_bins: { count: number; value: number };
	/** = stock_in_hand (GL). */
	total_stock_value: number;
	by_item_group: StockGroup[];
	warehouse_tree: WarehouseTreeNode[];
	warehouse_count: number;
	/** Top 10. */
	reorder_alerts: ReorderAlert[];
	/** True total. */
	reorder_count: number;
	dio: number | null;
	cogs_365d: number;
}
