import { useFrappeGetCall } from "frappe-react-sdk";
import type {
	CustomerSegmentsResponse,
	IntentFilter,
	OverviewResponse,
	PeriodSelection,
	SkuAssortmentResponse,
	TaxMode,
} from "@/types/mis";

export function useOverview(taxMode: TaxMode, period: PeriodSelection) {
	const params: Record<string, string> = { tax_mode: taxMode };
	if (period.kind !== "ttm") {
		params.from_date = period.from;
		params.to_date = period.to;
	}
	const key = periodKey(period);
	return useFrappeGetCall<{ message: OverviewResponse }>(
		"company_dashboard.api.mis.get_overview",
		params,
		`mis.get_overview::${taxMode}::${key}`,
		{ revalidateOnFocus: false, dedupingInterval: 60_000 },
	);
}

export function useFiscalYears() {
	return useFrappeGetCall<{
		message: Array<{ name: string; from: string; to: string }>;
	}>(
		"company_dashboard.api.mis.get_fiscal_years",
		{},
		"mis.fiscal_years",
		{ revalidateOnFocus: false, dedupingInterval: 5 * 60_000 },
	);
}

export function useSkuAssortment(taxMode: TaxMode, period: PeriodSelection, intent: IntentFilter) {
	const params: Record<string, string> = { tax_mode: taxMode, intent };
	if (period.kind !== "ttm") {
		params.from_date = period.from;
		params.to_date = period.to;
	}
	const key = `${periodKey(period)}::${intent}`;
	return useFrappeGetCall<{ message: SkuAssortmentResponse }>(
		"company_dashboard.api.mis.get_sku_assortment",
		params,
		`mis.get_sku_assortment::${taxMode}::${key}`,
		{ revalidateOnFocus: false, dedupingInterval: 60_000 },
	);
}

export function useCustomerSegments(
	taxMode: TaxMode,
	period: PeriodSelection,
	intent: IntentFilter,
) {
	const params: Record<string, string> = { tax_mode: taxMode, intent };
	if (period.kind !== "ttm") {
		params.from_date = period.from;
		params.to_date = period.to;
	}
	const key = `${periodKey(period)}::${intent}`;
	return useFrappeGetCall<{ message: CustomerSegmentsResponse }>(
		"company_dashboard.api.mis.get_customer_segments",
		params,
		`mis.get_customer_segments::${taxMode}::${key}`,
		{ revalidateOnFocus: false, dedupingInterval: 60_000 },
	);
}

function periodKey(p: PeriodSelection): string {
	if (p.kind === "ttm") return "ttm";
	if (p.kind === "fy") return `fy:${p.name}`;
	return `custom:${p.from}:${p.to}`;
}
