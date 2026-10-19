import { useMemo } from "react";
import { useDashState } from "@/lib/urlState";
import { deskGlHref, type ExplainCtx } from "@/lib/explain";
import type { PeriodInfo, PnlBucket } from "@/types/mis";

/** Builder context for <Explain> content on a page that has a loaded period. */
export function useExplainCtx(
	period: Pick<PeriodInfo, "from" | "to" | "label"> | undefined,
	company: string | undefined,
	bucket: PnlBucket = "overall",
): ExplainCtx {
	const { buildHref } = useDashState();
	return useMemo(
		() => ({
			periodLabel: period?.label ?? "",
			bucket,
			buildHref,
			glHref:
				period && company ? (accounts: string[]) => deskGlHref(company, period.from, period.to, accounts) : undefined,
		}),
		[period, company, bucket, buildHref],
	);
}
