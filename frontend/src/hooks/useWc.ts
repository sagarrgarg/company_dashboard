import { useFrappeGetCall } from "frappe-react-sdk";
import type {
	WcOverview,
	BankDetail,
	TradeReceivable,
	TradePayable,
	StockDetail,
} from "@/types/wc";

const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 60_000 };

/** All five WC endpoints read one server snapshot, keyed by company. */
function useWcCall<T>(method: string, company: string, refreshKey: number) {
	return useFrappeGetCall<{ message: T }>(
		`company_dashboard.api.wc.${method}`,
		company ? { company } : {},
		`wc.${method}::${company || "-"}::${refreshKey}`,
		SWR_OPTS,
	);
}

export const useWcOverview = (company: string, refreshKey = 0) =>
	useWcCall<WcOverview>("get_wc_overview", company, refreshKey);

export const useBankDetail = (company: string, refreshKey = 0) =>
	useWcCall<BankDetail>("get_bank_detail", company, refreshKey);

export const useTradeReceivable = (company: string, refreshKey = 0) =>
	useWcCall<TradeReceivable>("get_trade_receivable", company, refreshKey);

export const useTradePayable = (company: string, refreshKey = 0) =>
	useWcCall<TradePayable>("get_trade_payable", company, refreshKey);

export const useStockDetail = (company: string, refreshKey = 0) =>
	useWcCall<StockDetail>("get_stock_detail", company, refreshKey);
