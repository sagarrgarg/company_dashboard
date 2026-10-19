import { useFrappeGetCall } from "frappe-react-sdk";
import { baseKey, baseParams, type MisQuery } from "@/hooks/useOverview";
import type {
	AlertsResponse,
	BalanceSheetResponse,
	CashFlowResponse,
	ControlsResponse,
	LedgerDetailResponse,
	LedgerOrder,
	PnlStatementResponse,
	RatiosResponse,
	RevenueDetailResponse,
} from "@/types/finance";

const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 60_000 };
const M = "company_dashboard.api.finance";
const ST = "company_dashboard.api.statements";
const CT = "company_dashboard.api.controls";

/** Monthly CM ladder (ex-tax) for the period — same params as the Overview. */
export function usePnlStatement(q: MisQuery, enabled = true) {
	return useFrappeGetCall<{ message: PnlStatementResponse }>(
		`${M}.get_pnl_statement`,
		baseParams(q),
		enabled ? `fin.get_pnl_statement::${baseKey(q)}` : null,
		SWR_OPTS,
	);
}

export interface LedgerQuery {
	account: string;
	start: number;
	pageLength: number;
	orderBy: LedgerOrder;
}

/** One account (group accounts roll up their leaves) over the period. */
export function useLedgerDetail(q: MisQuery, l: LedgerQuery) {
	const params = {
		...periodCompany(q),
		account: l.account,
		start: String(l.start),
		page_length: String(l.pageLength),
		order_by: l.orderBy,
	};
	return useFrappeGetCall<{ message: LedgerDetailResponse }>(
		`${M}.get_ledger_detail`,
		params,
		l.account
			? `fin.get_ledger_detail::${baseKey(q)}::${l.account}::${l.start}::${l.pageLength}::${l.orderBy}`
			: null,
		SWR_OPTS,
	);
}

export interface RevenueQuery {
	incomeAccount?: string;
	bucket?: string;
	start: number;
	pageLength: number;
}

/** Invoices behind revenue, optionally one income account and/or one bucket. */
export function useRevenueDetail(q: MisQuery, r: RevenueQuery) {
	const params: Record<string, string> = {
		...periodCompany(q),
		start: String(r.start),
		page_length: String(r.pageLength),
	};
	if (r.incomeAccount) params.income_account = r.incomeAccount;
	if (r.bucket && r.bucket !== "overall") params.bucket = r.bucket;
	return useFrappeGetCall<{ message: RevenueDetailResponse }>(
		`${M}.get_revenue_detail`,
		params,
		`fin.get_revenue_detail::${baseKey(q)}::${r.incomeAccount ?? "-"}::${r.bucket ?? "-"}::${r.start}::${r.pageLength}`,
		SWR_OPTS,
	);
}

/** Ledger / revenue drills take the period and company, not the tax mode. */
function periodCompany(q: MisQuery): Record<string, string> {
	const { tax_mode: _t, ...rest } = baseParams(q);
	return rest;
}

/* ── Statements (period + company; no tax mode) ─────────────────────────── */

/** Schedule III balance sheet as of a date (YYYY-MM-DD; "" = today on the server). */
export function useBalanceSheet(asOf: string, company: string, refreshKey = 0) {
	const params: Record<string, string> = {};
	if (asOf) params.as_of = asOf;
	if (company) params.company = company;
	return useFrappeGetCall<{ message: BalanceSheetResponse }>(
		`${ST}.get_balance_sheet`,
		params,
		`st.get_balance_sheet::${company || "-"}::${asOf || "today"}::${refreshKey}`,
		SWR_OPTS,
	);
}

/** Period-scoped statement call; `enabled` false defers the request (lazy badges). */
function usePeriodCall<T>(method: string, q: MisQuery, enabled = true) {
	return useFrappeGetCall<{ message: T }>(
		method,
		periodCompany(q),
		enabled ? `${method}::${periodKeyNoTax(q)}` : null,
		SWR_OPTS,
	);
}

export const useCashFlow = (q: MisQuery) => usePeriodCall<CashFlowResponse>(`${ST}.get_cash_flow`, q);
export const useRatios = (q: MisQuery) => usePeriodCall<RatiosResponse>(`${ST}.get_ratios`, q);
export const useControls = (q: MisQuery, enabled = true) =>
	usePeriodCall<ControlsResponse>(`${CT}.get_controls`, q, enabled);
export const useAlerts = (q: MisQuery, enabled = true) =>
	usePeriodCall<AlertsResponse>(`${CT}.get_alerts`, q, enabled);

/** baseKey without the tax mode — these endpoints ignore it, so a tax toggle must not
 *  refetch them (and the sidebar badge shares the page's request). */
function periodKeyNoTax(q: MisQuery): string {
	return baseKey({ ...q, taxMode: "excl" });
}
