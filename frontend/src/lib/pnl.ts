import type { KPI, OverviewResponse } from "@/types/mis";

export type PnlBucket = "overall" | "b2c" | "b2b";

export interface PnlStep {
	/** Stable key — used as React key and accent class anchor. */
	key: string;
	/** Label shown on the chart x-axis and the table. */
	label: string;
	/** Indentation level for the table (0 = header, 1 = sub-line). */
	indent: 0 | 1;
	/** Absolute ₹ amount. Positive = subtotal/tier end; negative = deduction from prior subtotal. */
	amount: number;
	/** Running subtotal AFTER this step — lets the chart draw the waterfall without recomputation. */
	subtotal: number;
	/** Role of the step in the waterfall — drives colour + indentation. */
	kind: "anchor" | "deduction" | "tier";
	/** Optional account-count or sub-breakdown for the table "details" column. */
	note?: string;
}

/** Build a per-bucket P&L waterfall from the Overview response.
 *
 *  Revenue → (−COGS) → CM1 → (−variable) → CM2 → (−marketing) → CM3
 *          → (−operating) → EBITDA → (−D&A) → EBIT → (−interest) → PBT → (−tax) → PAT
 */
export function buildPnlSteps(res: OverviewResponse, bucket: PnlBucket): PnlStep[] {
	const { kpi, cm2_inputs: c2, cm3_inputs: c3, ladder_inputs: li } = res;

	// Revenue and tier values vary by bucket. COGS, variable, marketing etc. are aggregate
	// totals at the company level; per-bucket values are revenue-share-allocated (the same
	// caveat documented in the MIS API). We use the `share` ratio to split them here so the
	// waterfall numbers line up to the per-bucket tier subtotals that the API already returns.
	const revenue = revenueOf(kpi, bucket);
	const cm1 = valueOf(kpi, bucket, "cm1");
	const cm2 = valueOf(kpi, bucket, "cm2");
	const cm3 = valueOf(kpi, bucket, "cm3");
	const ebitda = valueOf(kpi, bucket, "ebitda");
	const ebit = valueOf(kpi, bucket, "ebit");
	const pbt = bucket === "overall" ? kpi.pbt : undefined;
	const pat = valueOf(kpi, bucket, "pat");

	// Per-bucket deductions via share of revenue (aggregate numbers divided proportionally).
	const totalRev = kpi.total_revenue || 1;
	const share = bucket === "overall" ? 1 : revenue / totalRev;

	const cogs = revenue - cm1; // GP already tells us COGS
	const variable = c2.variable_total * share;
	const marketing = c3.marketing_total * share;
	const operating = li.operating_total * share;
	const da = li.da_total * share;
	const interest = li.interest_total * share;
	const tax = li.tax_total * share;

	const steps: PnlStep[] = [
		{ key: "rev", label: "Gross Revenue", indent: 0, kind: "anchor", amount: revenue, subtotal: revenue },
		{
			key: "cogs",
			label: "COGS (incoming_rate × qty)",
			indent: 1,
			kind: "deduction",
			amount: -cogs,
			subtotal: cm1,
			note: "includes primary packaging via BOM",
		},
		{ key: "cm1", label: "CM1 · Gross Margin", indent: 0, kind: "tier", amount: cm1, subtotal: cm1 },

		{
			key: "variable",
			label: "Variable fulfillment",
			indent: 1,
			kind: "deduction",
			amount: -variable,
			subtotal: cm2,
			note: variableNote(c2),
		},
		{ key: "cm2", label: "CM2 · Before marketing", indent: 0, kind: "tier", amount: cm2, subtotal: cm2 },

		{
			key: "marketing",
			label: "Marketing",
			indent: 1,
			kind: "deduction",
			amount: -marketing,
			subtotal: cm3,
			note: `${c3.marketing_accounts.length} account${c3.marketing_accounts.length === 1 ? "" : "s"}`,
		},
		{ key: "cm3", label: "CM3 · After marketing", indent: 0, kind: "tier", amount: cm3, subtotal: cm3 },

		{
			key: "operating",
			label: "Operating overhead",
			indent: 1,
			kind: "deduction",
			amount: -operating,
			subtotal: ebitda,
			note: operatingNote(li),
		},
		{ key: "ebitda", label: "EBITDA", indent: 0, kind: "tier", amount: ebitda, subtotal: ebitda },

		{
			key: "da",
			label: "Depreciation & Amortization",
			indent: 1,
			kind: "deduction",
			amount: -da,
			subtotal: ebit,
			note:
				li.da_accounts.length > 0
					? `${li.da_accounts.length} account${li.da_accounts.length === 1 ? "" : "s"}`
					: "none booked TTM",
		},
		{ key: "ebit", label: "EBIT", indent: 0, kind: "tier", amount: ebit, subtotal: ebit },

		{
			key: "interest",
			label: "Interest & Finance",
			indent: 1,
			kind: "deduction",
			amount: -interest,
			subtotal: pbt ?? ebit - interest,
			note: `${li.interest_accounts.length} account${li.interest_accounts.length === 1 ? "" : "s"}`,
		},
		{
			key: "pbt",
			label: "PBT · Profit Before Tax",
			indent: 0,
			kind: "tier",
			amount: pbt ?? ebit - interest,
			subtotal: pbt ?? ebit - interest,
		},

		{
			key: "tax",
			label: "Income Tax",
			indent: 1,
			kind: "deduction",
			amount: -tax,
			subtotal: pat,
			note:
				li.tax_accounts.length === 0
					? "no tax accounts configured"
					: tax > 0
						? `${li.tax_accounts.length} account${li.tax_accounts.length === 1 ? "" : "s"}`
						: "none TTM (likely losses)",
		},
		{ key: "pat", label: "PAT · Profit After Tax", indent: 0, kind: "tier", amount: pat, subtotal: pat },
	];

	return steps;
}

function revenueOf(kpi: KPI, bucket: PnlBucket): number {
	if (bucket === "b2c") return kpi.b2c_revenue;
	if (bucket === "b2b") return kpi.b2b_revenue;
	return kpi.total_revenue;
}

type Tier = "cm1" | "cm2" | "cm3" | "ebitda" | "ebit" | "pat";

function valueOf(kpi: KPI, bucket: PnlBucket, tier: Tier): number {
	const prefix = bucket === "overall" ? "" : `${bucket}_`;
	const field = `${prefix}${tier}` as keyof KPI;
	const raw = kpi[field];
	return typeof raw === "number" ? raw : 0;
}

function variableNote(c2: OverviewResponse["cm2_inputs"]): string {
	const parts: string[] = [];
	if (c2.freight_accounts.length) parts.push(`${c2.freight_accounts.length} freight`);
	if (c2.packaging_accounts.length) parts.push(`${c2.packaging_accounts.length} pkg`);
	if (c2.commission_accounts.length) parts.push(`${c2.commission_accounts.length} txn`);
	if (c2.scheme_accounts.length) parts.push(`${c2.scheme_accounts.length} scheme`);
	return parts.join(" · ");
}

function operatingNote(li: OverviewResponse["ladder_inputs"]): string {
	const parts: string[] = [];
	if (li.salary_accounts.length) parts.push(`${li.salary_accounts.length} salary`);
	if (li.rent_accounts.length) parts.push(`${li.rent_accounts.length} rent`);
	if (li.utility_accounts.length) parts.push(`${li.utility_accounts.length} util`);
	if (li.admin_accounts.length) parts.push(`${li.admin_accounts.length} admin`);
	return parts.join(" · ");
}
