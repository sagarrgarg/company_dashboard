import { useFrappeGetCall } from "frappe-react-sdk";
import type {
	WcOverview,
	BankDetail,
	TradeReceivable,
	TradePayable,
	StockDetail,
} from "@/types/wc";

const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 60_000 };

export function useWcOverview(refreshKey = 0) {
	return useFrappeGetCall<{ message: WcOverview }>(
		"company_dashboard.api.wc.get_wc_overview",
		{},
		`wc.overview::${refreshKey}`,
		SWR_OPTS,
	);
}

export function useBankDetail(refreshKey = 0) {
	return useFrappeGetCall<{ message: BankDetail }>(
		"company_dashboard.api.wc.get_bank_detail",
		{},
		`wc.bank_detail::${refreshKey}`,
		SWR_OPTS,
	);
}

export function useTradeReceivable(refreshKey = 0) {
	return useFrappeGetCall<{ message: TradeReceivable }>(
		"company_dashboard.api.wc.get_trade_receivable",
		{},
		`wc.trade_receivable::${refreshKey}`,
		SWR_OPTS,
	);
}

export function useTradePayable(refreshKey = 0) {
	return useFrappeGetCall<{ message: TradePayable }>(
		"company_dashboard.api.wc.get_trade_payable",
		{},
		`wc.trade_payable::${refreshKey}`,
		SWR_OPTS,
	);
}

export function useStockDetail(refreshKey = 0) {
	return useFrappeGetCall<{ message: StockDetail }>(
		"company_dashboard.api.wc.get_stock_detail",
		{},
		`wc.stock_detail::${refreshKey}`,
		SWR_OPTS,
	);
}
