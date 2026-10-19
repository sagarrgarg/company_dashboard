import type { ComingSoonKey, ComingSoonTiles } from "@/lib/boot";
import { costExceedsRevenue, formatINR, marginState } from "@/lib/utils";
import type { ApiPnlStep, OverviewResponse, PnlBucket, PnlStepKey } from "@/types/mis";

export type { PnlBucket };

export interface PnlStep extends ApiPnlStep {
	/** 0 = anchor / tier row, 1 = deduction sub-line. */
	indent: 0 | 1;
	/** Hidden by a "Coming soon" flag (amount and %). */
	hidden: boolean;
	/** Only the ₹ amount is hidden (Gross Profit flag on CM1). */
	amountHidden: boolean;
	/** Accounts behind the line, for the row tooltip. */
	accounts: string[];
}

/** "Coming soon" flag that hides each P&L line — the same figure as the Overview tile. */
export const STEP_FLAG: Partial<Record<PnlStepKey, ComingSoonKey>> = {
	ebitda: "ebitda",
	ebit: "ebit",
	pat: "pat",
	salary: "operating_opex",
	rent: "operating_opex",
	utility: "operating_opex",
	admin: "operating_opex",
	interest: "interest_finance",
	tax: "income_tax",
};

export function bucketHidden(bucket: PnlBucket, flags: ComingSoonTiles): boolean {
	return bucket === "unclassified" && flags.unclassified_rev;
}

function accountsFor(res: OverviewResponse, key: PnlStepKey): string[] {
	const li = res.ladder_inputs;
	const c2 = res.cm2_inputs;
	const withAmt = (rows: { account: string; amount: number }[]) =>
		rows.map((r) => `${r.account}: ${formatINR(r.amount)}`);
	switch (key) {
		case "cogs":
			return withAmt(li.cogs_accounts ?? []);
		case "direct":
			return li.direct_accounts ?? [];
		case "freight":
			return c2.freight_accounts;
		case "packaging":
			return c2.packaging_accounts;
		case "commission":
			return c2.commission_accounts;
		case "scheme":
			return c2.scheme_accounts;
		case "marketing":
			return res.cm3_inputs.marketing_accounts;
		case "salary":
			return li.salary_accounts;
		case "rent":
			return li.rent_accounts;
		case "utility":
			return li.utility_accounts;
		case "admin":
			return li.admin_accounts;
		case "other":
			return [
				...withAmt(li.unmapped_expense_accounts ?? []),
				...(li.other_income_accounts ?? []).map((r) => `${r.account} (income): ${formatINR(r.amount)}`),
			];
		case "internal":
			return withAmt(li.internal_accounts ?? []);
		case "da":
			return li.da_accounts;
		case "interest":
			return li.interest_accounts;
		case "tax":
			return li.tax_accounts;
		default:
			return [];
	}
}

/** The P&L ladder for one bucket, straight from the API (`res.pnl[bucket]`, ex-tax, ties
 *  to GL net profit). No figures are derived here. */
export function buildPnlSteps(res: OverviewResponse, bucket: PnlBucket, flags: ComingSoonTiles): PnlStep[] {
	const steps = res.pnl?.[bucket] ?? [];
	return steps.map((s) => {
		const flag = STEP_FLAG[s.key];
		return {
			...s,
			indent: s.kind === "deduction" ? 1 : 0,
			hidden: Boolean(flag && flags[flag]),
			amountHidden: s.key === "cm1" && flags.gross_profit,
			accounts: accountsFor(res, s.key),
		};
	});
}

/** True when a tier margin is beyond ±100% or cost of goods is above 2× revenue. */
export function stepsLookImpossible(steps: ApiPnlStep[]): boolean {
	const revenue = steps.find((s) => s.key === "revenue")?.amount ?? 0;
	return steps.some(
		(s) =>
			(s.kind === "tier" && marginState(s.pct) === "bogus") ||
			(s.key === "cogs" && costExceedsRevenue(s.amount, revenue)),
	);
}
