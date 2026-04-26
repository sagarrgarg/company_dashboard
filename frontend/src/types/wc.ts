export interface WcOverview {
	company: string;
	as_of: string;
	refreshed_at?: string;
	kpi: {
		net_working_capital: number;
		bank_balance: number;
		trade_receivable: number;
		trade_payable: number;
		stock_in_hand: number;
		ccc: number;
		dso: number;
		dpo: number;
		dio: number;
	};
	bank_account_count: number;
}

export interface BankAccount {
	account: string;
	balance: number;
	last_posting_date: string | null;
}

export interface BankTrendPoint {
	month: string;
	year: number;
	balance: number;
}

export interface BankDetail {
	company: string;
	accounts: BankAccount[];
	total_balance: number;
	account_count: number;
	trend: BankTrendPoint[];
	cash_burn_monthly: number;
	days_cash_on_hand: number;
}

export interface AgingBucket {
	label: string;
	amount: number;
	pct: number;
}

export interface AgingData {
	total_outstanding: number;
	total_overdue: number;
	buckets: AgingBucket[];
}

export interface PartyRow {
	party: string;
	party_name: string;
	customer_group?: string;
	supplier_group?: string;
	outstanding: number;
	age_days: number;
	status: "Current" | "Watch" | "Overdue";
	invoiced: number;
	paid: number;
}

export interface TradeReceivable {
	company: string;
	as_of: string;
	aging: AgingData;
	top_debtors: PartyRow[];
	dso: number;
	collection_efficiency: number;
}

export interface TradePayable {
	company: string;
	as_of: string;
	aging: AgingData;
	top_creditors: PartyRow[];
	dpo: number;
	advance_paid: number;
}

export interface StockGroup {
	item_group: string;
	stock_value: number;
	sku_count: number;
}

export interface ReorderAlert {
	item_code: string;
	item_name: string;
	item_group: string;
	actual_qty: number;
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

export interface StockDetail {
	company: string;
	total_stock_value: number;
	by_item_group: StockGroup[];
	warehouse_tree: WarehouseTreeNode[];
	warehouse_count: number;
	reorder_alerts: ReorderAlert[];
	reorder_count: number;
	dio: number;
}
