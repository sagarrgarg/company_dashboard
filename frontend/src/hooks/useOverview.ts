import { useFrappeGetCall } from "frappe-react-sdk";
import type {
	CustomerSegmentsResponse,
	FiscalYear,
	IntentFilter,
	OverviewResponse,
	PeriodSelection,
	SkuAssortmentResponse,
	TaxMode,
} from "@/types/mis";

/** Filters shared by every MIS page. `company` "" = let the server pick its default. */
export interface MisQuery {
	taxMode: TaxMode;
	period: PeriodSelection;
	company: string;
	refreshKey: number;
}

const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 60_000 };

export function baseParams(q: MisQuery): Record<string, string> {
	const params: Record<string, string> = { tax_mode: q.taxMode };
	if (q.period.kind !== "ttm") {
		params.from_date = q.period.from;
		params.to_date = q.period.to;
	}
	if (q.company) params.company = q.company;
	return params;
}

export function baseKey(q: MisQuery): string {
	return `${q.company || "-"}::${q.taxMode}::${periodKey(q.period)}::${q.refreshKey}`;
}

export function useOverview(q: MisQuery) {
	return useFrappeGetCall<{ message: OverviewResponse }>(
		"company_dashboard.api.mis.get_overview",
		baseParams(q),
		`mis.get_overview::${baseKey(q)}`,
		SWR_OPTS,
	);
}

export function useFiscalYears(company: string) {
	return useFrappeGetCall<{ message: FiscalYear[] }>(
		"company_dashboard.api.mis.get_fiscal_years",
		company ? { company } : {},
		`mis.fiscal_years::${company || "-"}`,
		{ revalidateOnFocus: false, dedupingInterval: 5 * 60_000 },
	);
}

export function useCompanies() {
	return useFrappeGetCall<{ message: string[] }>(
		"company_dashboard.api.mis.get_companies",
		{},
		"mis.companies",
		{ revalidateOnFocus: false, dedupingInterval: 5 * 60_000 },
	);
}

export function useSkuAssortment(q: MisQuery, intent: IntentFilter) {
	return useFrappeGetCall<{ message: SkuAssortmentResponse }>(
		"company_dashboard.api.mis.get_sku_assortment",
		{ ...baseParams(q), intent },
		`mis.get_sku_assortment::${baseKey(q)}::${intent}`,
		SWR_OPTS,
	);
}

export function useCustomerSegments(q: MisQuery, intent: IntentFilter) {
	return useFrappeGetCall<{ message: CustomerSegmentsResponse }>(
		"company_dashboard.api.mis.get_customer_segments",
		{ ...baseParams(q), intent },
		`mis.get_customer_segments::${baseKey(q)}::${intent}`,
		SWR_OPTS,
	);
}

function periodKey(p: PeriodSelection): string {
	if (p.kind === "ttm") return "ttm";
	if (p.kind === "fy") return `fy:${p.name}:${p.from}:${p.to}`;
	return `custom:${p.from}:${p.to}`;
}
