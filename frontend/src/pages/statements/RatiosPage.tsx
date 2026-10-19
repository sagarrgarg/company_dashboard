/** /mis/ratios — Schedule III ratios (+ a few CFO staples) as cards: value, prior year
 *  and change coloured favourable / unfavourable, the > 25% change flag, and an
 *  explanation with numerator ÷ denominator. */
import { useEffect } from "react";
import { DrillHeader, DrillSkeleton } from "@/components/drill/DrillLayout";
import { Explain } from "@/components/explain/Explain";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { useRatios } from "@/hooks/useFinance";
import { explainRatio, formatRatio, ratioTone } from "@/lib/statements";
import { cn, formatPct } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { Ratio, RatiosResponse } from "@/types/finance";

const GROUPS: Array<{ title: string; keys: string[] }> = [
	{ title: "Liquidity", keys: ["current_ratio", "quick_ratio"] },
	{ title: "Leverage & coverage", keys: ["debt_equity", "dscr", "interest_coverage", "net_debt_ebitda"] },
	{ title: "Returns", keys: ["roe", "roce", "net_profit_ratio"] },
	{ title: "Margins", keys: ["gross_margin", "ebitda_margin"] },
	{ title: "Efficiency", keys: ["inventory_turnover", "receivables_turnover", "payables_turnover", "net_capital_turnover"] },
];

export function RatiosPage({ query, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const { data, error, isLoading } = useRatios(query);
	const res = data?.message;

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const header = (
		<>
			<PreparedReportHeader refreshedAt={res?.refreshed_at} stale={res?.stale} section="mis" onRefreshed={onRefreshed} />
			<DrillHeader
				eyebrow="Statements · Ratios · Schedule III · ratios in × or %"
				title="Financial ratios"
				subtitle={
					res ? (
						<>
							{res.period.label} · {res.company}
							{res.annualised && <span className="ml-1.5 badge bg-blue-bg text-blue !py-0">annualised</span>}
						</>
					) : undefined
				}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
			/>
		</>
	);

	if (isLoading && !res) return (<>{header}<DrillSkeleton /></>);
	if (error || !res) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load ratios" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}
	return (
		<>
			{header}
			<RatiosBody res={res} />
		</>
	);
}

function RatiosBody({ res }: { res: RatiosResponse }) {
	const known = new Set(GROUPS.flatMap((g) => g.keys));
	const groups = [
		...GROUPS.map((g) => ({ title: g.title, ratios: g.keys.map((k) => res.ratios.find((r) => r.key === k)).filter((r): r is Ratio => !!r) })),
		{ title: "Other", ratios: res.ratios.filter((r) => !known.has(r.key)) },
	].filter((g) => g.ratios.length);
	const flagged = res.ratios.filter((r) => r.flag_25pct).length;
	const noPrior = res.ratios.every((r) => r.prior == null);

	return (
		<>
			{(flagged > 0 || noPrior || res.annualised) && (
				<div className="text-[11.5px] text-text-2 mb-4 leading-relaxed">
					{flagged > 0 && (
						<span className="font-semibold text-amber">⚠ {flagged} ratio{flagged === 1 ? "" : "s"} moved more than 25% — Schedule III asks for an explanation. </span>
					)}
					{res.annualised && "The period isn't a full year: P&L flows are annualised before dividing by balances. "}
					{noPrior && "No prior-year comparison: the same period last year isn't covered by the ledger."}
				</div>
			)}
			{groups.map((g) => (
				<section key={g.title} className="mb-5">
					<div className="sec-label">{g.title}</div>
					<div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
						{g.ratios.map((r) => (
							<RatioCard key={r.key} r={r} res={res} />
						))}
					</div>
				</section>
			))}
		</>
	);
}

function RatioCard({ r, res }: { r: Ratio; res: RatiosResponse }) {
	const tone = ratioTone(r);
	const content = () => explainRatio(r, { periodLabel: res.period.label, annualised: res.annualised });
	const valueText = formatRatio(r, r.value);
	return (
		<div className={cn("kpi flex flex-col", r.flag_25pct && "ring-1 ring-amber/40")}>
			<div className="kpi-lbl flex items-start justify-between gap-2">
				<span>{r.label}</span>
				<span className="text-[9px] text-text-4 font-semibold whitespace-nowrap" title={r.higher_is_better ? "Higher is better" : "Lower is better"}>
					{r.higher_is_better ? "↑ better" : "↓ better"}
				</span>
			</div>
			<div className={cn("kpi-val", r.value == null && "text-text-4")}>
				<Explain content={content} label={`${r.label}, ${valueText}, has breakdown`}>
					{valueText}
				</Explain>
			</div>
			<div className="kpi-meta flex-wrap">
				{r.prior == null ? (
					<span className="chg bg-surface-3 text-text-3">no PY</span>
				) : (
					<>
						<span className="text-text-3">PY {formatRatio(r, r.prior)}</span>
						{r.change_pct != null && (
							<span
								className={cn(
									"chg",
									tone === "good" ? "bg-green-bg text-green" : tone === "bad" ? "bg-red-bg text-red" : "bg-surface-3 text-text-3",
								)}
								title={tone === "good" ? "Favourable" : tone === "bad" ? "Unfavourable" : undefined}
							>
								{r.change_pct > 0 ? "↑" : r.change_pct < 0 ? "↓" : ""}
								{formatPct(Math.abs(r.change_pct), 0)}
							</span>
						)}
					</>
				)}
				{r.flag_25pct && <span className="chg bg-amber-bg text-amber" title="Schedule III: explain a change of more than 25%">⚠ Δ &gt; 25%</span>}
			</div>
			<div className="text-[10.5px] text-text-3 mt-2 leading-snug">{r.formula}</div>
		</div>
	);
}
