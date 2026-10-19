/** Typed access to window.frappe.boot (injected by www/bizdashboard.html, or fetched by
 *  main.tsx from get_context_for_dev in Vite dev). */

export interface DashboardSections {
	mis: boolean;
	wc: boolean;
}

export type ComingSoonKey =
	| "ebitda"
	| "ebit"
	| "pat"
	| "gross_profit"
	| "active_skus"
	| "unclassified_rev"
	| "operating_opex"
	| "interest_finance"
	| "income_tax";

export type ComingSoonTiles = Record<ComingSoonKey, boolean>;

export const EMPTY_COMING_SOON: ComingSoonTiles = {
	ebitda: false,
	ebit: false,
	pat: false,
	gross_profit: false,
	active_skus: false,
	unclassified_rev: false,
	operating_opex: false,
	interest_finance: false,
	income_tax: false,
};

interface Boot {
	company_dashboard?: {
		default_company?: string;
		sections?: DashboardSections;
		coming_soon_tiles?: Partial<ComingSoonTiles>;
	};
	time_zone?: { system?: string; user?: string | null };
	sysdefaults?: { time_zone?: string };
}

function boot(): Boot | undefined {
	return window.frappe?.boot as Boot | undefined;
}

export function bootDefaultCompany(): string {
	return boot()?.company_dashboard?.default_company ?? "";
}

export function bootSections(): DashboardSections {
	return boot()?.company_dashboard?.sections ?? { mis: true, wc: true };
}

export function bootComingSoon(): ComingSoonTiles {
	return { ...EMPTY_COMING_SOON, ...(boot()?.company_dashboard?.coming_soon_tiles ?? {}) };
}

/** System timezone of the Frappe site — server timestamps are naive in this zone. */
export function serverTimeZone(): string | undefined {
	const b = boot();
	return b?.time_zone?.system || b?.sysdefaults?.time_zone || undefined;
}
