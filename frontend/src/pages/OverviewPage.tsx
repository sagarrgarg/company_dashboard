import { useEffect } from "react";
import { KpiTile, type KpiAccent } from "@/components/widgets/KpiTile";
import { MarginTile } from "@/components/widgets/MarginTile";
import { RevenueTrendChart } from "@/components/widgets/RevenueTrendChart";
import { RevenueMixChart } from "@/components/widgets/RevenueMixChart";
import { CategoryTable } from "@/components/widgets/CategoryTable";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { DownloadButtons } from "@/components/widgets/DownloadButtons";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { DataQualityBanner } from "@/components/widgets/DataQualityBanner";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { LadderFootnote } from "@/components/widgets/LadderFootnote";
import { Explain } from "@/components/explain/Explain";
import { StatementsStrip } from "@/components/statements/StatementBits";
import { useExplainCtx } from "@/hooks/useExplainCtx";
import { explainComposite, explainStep, type ExplainContent, type ExplainCtx } from "@/lib/explain";
import { useOverview } from "@/hooks/useOverview";
import { useComingSoon } from "@/hooks/useUiFlags";
import { stepsLookImpossible } from "@/lib/pnl";
import {
	cn,
	costExceedsRevenue,
	formatINR,
	formatMargin,
	formatNumber,
	growthDelta,
	marginState,
	marginTitle,
	mixShares,
	periodShort,
	PRIOR_INCOMPLETE,
	type Delta,
} from "@/lib/utils";
import type { ComingSoonTiles } from "@/lib/boot";
import type { MisPageProps } from "@/App";
import type { OverviewResponse, PnlBucket, PnlStepKey } from "@/types/mis";

/** Accent for a margin tile: impossible / n/a values never look green. */
function marginAccent(pct: number | null, good: number): KpiAccent {
	if (marginState(pct) !== "ok" || pct == null) return "amber";
	return pct > good ? "green" : pct > 0 ? "amber" : "red";
}

export function OverviewPage({ query, onTaxModeChange, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const { data, error, isLoading } = useOverview(query);
	const res = data?.message;
	const comingSoon = useComingSoon();

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const controls = (
		<div className="flex items-center gap-2 flex-wrap justify-end">
			<DownloadButtons taxMode={query.taxMode} period={query.period} company={query.company} />
			<PeriodPicker value={query.period} onChange={onPeriodChange} company={query.company} />
			<TaxModeTabs value={query.taxMode} onChange={onTaxModeChange} />
		</div>
	);

	if (isLoading && !res) {
		return (
			<div className="space-y-4">
				<div className="flex justify-between items-start">
					<div className="h-10 w-72 bg-surface-2 rounded animate-pulse" />
					{controls}
				</div>
				<div className="animate-pulse space-y-4">
					{[0, 1, 2].map((row) => (
						<div key={row} className="grid grid-cols-5 gap-2.5">
							{Array.from({ length: 5 }).map((_, i) => (
								<div key={i} className="h-24 bg-surface-2 rounded-[12px]" />
							))}
						</div>
					))}
					<div className="h-64 bg-surface-2 rounded-[12px]" />
				</div>
			</div>
		);
	}
	if (error || !res) {
		return (
			<>
				<header className="flex justify-between items-start mb-7 gap-4">
					<div>
						<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
							MIS Overview
						</div>
						<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
							{query.company || "Overview"}
						</h1>
					</div>
					{controls}
				</header>
				<ErrorCard
					title="Unable to load MIS data"
					error={error ?? "The server returned no data."}
					period={query.period}
					onPeriodChange={onPeriodChange}
					hint="If ERPNext isn't installed on this site the Overview cannot read Sales Invoice data. Otherwise pick another period or press Refresh."
				/>
			</>
		);
	}

	return <OverviewBody res={res} controls={controls} onRefreshed={onRefreshed} comingSoon={comingSoon} refreshKey={query.refreshKey} />;
}

function OverviewBody({
	res,
	controls,
	onRefreshed,
	comingSoon,
	refreshKey,
}: {
	res: OverviewResponse;
	controls: React.ReactNode;
	onRefreshed: () => void;
	comingSoon: ComingSoonTiles;
	refreshKey: number;
}) {
	const { kpi, monthly, categories, period, ladder_inputs: li, cm2_inputs: c2 } = res;
	const priorOk = period.prior.available && kpi.prior_available !== false;
	const totalDelta = growthDelta(kpi.total_revenue, kpi.total_revenue_prior, priorOk);
	const b2cDelta = growthDelta(kpi.b2c_revenue, kpi.b2c_revenue_prior, priorOk);
	const b2bDelta = growthDelta(kpi.b2b_revenue, kpi.b2b_revenue_prior, priorOk);
	const uncDelta = growthDelta(kpi.unclassified_revenue, kpi.unclassified_revenue_prior, priorOk);
	// One rounding for tiles and donut alike.
	const mix = mixShares(
		{ b2c: kpi.b2c_revenue, b2b: kpi.b2b_revenue, unclassified: kpi.unclassified_revenue },
		kpi.total_revenue,
	);
	const revBasis = res.basis?.revenue === "incl" ? "incl. tax" : "ex-tax";
	const revBasisLong = res.basis?.revenue === "incl" ? "Tax-inclusive revenue" : "Tax-exclusive revenue";
	const inPeriod = periodShort(period);
	const cmp = period.comparison_label;
	const cs = comingSoon;
	/** ₹ amount, or "(soon)" when its tile is flagged "Coming soon" (F8). */
	const amt = (flag: keyof ComingSoonTiles | null, v: number) => (flag && cs[flag] ? "(soon)" : formatINR(v));

	const buckets: PnlBucket[] = ["overall", "b2c", "b2b", "unclassified"];
	const impossible = buckets.some((b) => stepsLookImpossible(res.pnl?.[b] ?? []));
	const costOver = costExceedsRevenue(kpi.cogs, kpi.total_revenue_excl);
	const uncShareAbs = kpi.total_revenue ? Math.abs(kpi.unclassified_revenue / kpi.total_revenue) : 0;

	const deltaText = (d: Delta) => (d.unavailable ? PRIOR_INCOMPLETE : `${d.label} ${cmp}`);

	// Every ladder number explains itself (A3) — content comes from the payload, no fetch.
	const ctx = useExplainCtx(period, res.company, "overall");
	const ex = (key: PnlStepKey, bucket: PnlBucket = "overall", opts?: Parameters<typeof explainStep>[2]) => {
		const step = res.pnl?.[bucket]?.find((s) => s.key === key);
		if (!step) return undefined;
		return explainStep(step, bucket === "overall" ? ctx : { ...ctx, bucket }, opts);
	};
	const revNote =
		res.basis?.revenue === "incl"
			? ["The tile shows tax-inclusive revenue; the ladder and these accounts are ex-tax."]
			: undefined;
	const revEx = (bucket: PnlBucket, shown: number) =>
		ex("revenue", bucket, { notes: revNote, valueSub: res.basis?.revenue === "incl" ? `ex-tax · tile ${formatINR(shown)} incl. tax` : undefined });
	const patEx = ex("pat", "overall", {
		notes: [
			`PAT ${formatINR(kpi.pat)} vs GL net profit ${formatINR(li.gl_net_profit)} ${Math.abs(kpi.pat - li.gl_net_profit) <= 1 ? "✓ ties" : "⚠ differs"}.`,
		],
	});
	const opexSteps = (["salary", "rent", "utility", "admin"] as PnlStepKey[])
		.map((k) => res.pnl?.overall?.find((s) => s.key === k))
		.filter((s): s is NonNullable<typeof s> => Boolean(s));
	const opexEx = explainComposite("Operating opex", opexSteps, ctx, {
		expected: li.operating_total,
		valueSub: "salary + rent + utilities + admin",
	});
	const growthEx = (label: string, bucket: PnlBucket, cur: number, prior: number, d: Delta) =>
		growthExplain(label, bucket, cur, prior, d, ctx, period.comparison_label, revBasis);

	return (
		<>
			<PreparedReportHeader
				refreshedAt={res.refreshed_at}
				stale={res.stale}
				section="mis"
				onRefreshed={onRefreshed}
			/>
			<header className="flex flex-col lg:flex-row lg:justify-between lg:items-start mb-7 gap-4">
				<div className="min-w-0">
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						MIS Overview · {revBasisLong} · margins ex-tax
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">{res.company}</h1>
					<div className="text-[12px] text-text-2 mt-1.5 font-medium">
						{period.label} · {categories.length} categories
						{!cs.active_skus && <> · {formatNumber(kpi.active_skus)} live SKUs</>}
					</div>
					<div className="flex gap-1.5 mt-3 flex-wrap">
						<ChipExplain content={growthEx("B2C", "b2c", kpi.b2c_revenue, kpi.b2c_revenue_prior, b2cDelta)}>
							<span className="badge bg-green-bg text-green">
								B2C {b2cDelta.unavailable ? "growth n/a" : `${b2cDelta.label} ${cmp}`}
							</span>
						</ChipExplain>
						<ChipExplain content={growthEx("B2B", "b2b", kpi.b2b_revenue, kpi.b2b_revenue_prior, b2bDelta)}>
							<span className="badge bg-amber-bg text-amber">
								B2B {b2bDelta.unavailable ? "growth n/a" : `${b2bDelta.label} ${cmp}`}
							</span>
						</ChipExplain>
						<ChipExplain content={ex("cm1")}>
							<span className="badge bg-teal-bg text-teal" title={marginTitle(kpi.cm1_pct)}>
								CM1 · GM {formatMargin(kpi.cm1_pct)}
							</span>
						</ChipExplain>
						<ChipExplain content={ex("cm2")}>
							<span className="badge bg-purple-bg text-purple" title={marginTitle(kpi.cm2_pct)}>
								CM2 {formatMargin(kpi.cm2_pct)}
							</span>
						</ChipExplain>
						<ChipExplain content={ex("cm3")}>
						<span
							className={cn(
								"badge",
								marginState(kpi.cm3_pct) !== "ok"
									? "bg-amber-bg text-amber"
									: (kpi.cm3_pct ?? 0) >= 0
										? "bg-green-bg text-green"
										: "bg-red-bg text-red",
							)}
							title={marginTitle(kpi.cm3_pct)}
						>
							CM3 {formatMargin(kpi.cm3_pct)}
						</span>
						</ChipExplain>
						{!cs.pat && (
							<ChipExplain content={patEx}>
							<span
								className={cn(
									"badge font-semibold",
									marginState(kpi.pat_pct) !== "ok"
										? "bg-amber-bg text-amber"
										: (kpi.pat_pct ?? 0) >= 0
											? "bg-green-bg text-green"
											: "bg-red-bg text-red",
								)}
								title={marginTitle(kpi.pat_pct)}
							>
								PAT {formatMargin(kpi.pat_pct)}
							</span>
							</ChipExplain>
						)}
					</div>
				</div>
				<div className="flex flex-col items-start lg:items-end gap-2.5">
					{controls}
					<div className="lg:text-right">
						<div className="text-[10px] font-semibold tracking-[0.12em] uppercase text-text-3">
							Total Revenue · {revBasis}
						</div>
						<div className="text-[28px] md:text-[34px] font-semibold text-text leading-[1.05] tracking-tight tabular-nums">
							<ChipExplain content={revEx("overall", kpi.total_revenue)} underline>
								{formatINR(kpi.total_revenue)}
							</ChipExplain>
						</div>
						<div
							className={cn(
								"text-[12px] font-medium tabular-nums",
								totalDelta.direction === "up"
									? "text-green"
									: totalDelta.direction === "down"
										? "text-red"
										: "text-text-3",
							)}
							title={
								totalDelta.unavailable
									? `Data starts ${period.prior.data_starts ?? "—"}; prior window ${period.prior.from} – ${period.prior.to} is ${period.prior.coverage_pct}% covered.`
									: undefined
							}
						>
							{deltaText(totalDelta)}
						</div>
					</div>
				</div>
			</header>

			<StatementsStrip refreshKey={refreshKey} />

			<DataQualityBanner dq={res.data_quality} impossibleMargins={impossible} costOverRevenue={costOver} />

			<div className="sec-label">Revenue — {inPeriod} · {revBasis}</div>
			<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2.5 mb-2.5">
				<KpiTile
					label="Total Revenue"
					basis={revBasis}
					value={formatINR(kpi.total_revenue)}
					explain={revEx("overall", kpi.total_revenue)}
					delta={totalDelta}
					meta={totalDelta.unavailable ? undefined : cmp}
				/>
				<KpiTile
					label="B2C Revenue"
					basis={revBasis}
					value={formatINR(kpi.b2c_revenue)}
					explain={revEx("b2c", kpi.b2c_revenue)}
					accent="green"
					delta={b2cDelta}
					meta={mix.b2c == null ? undefined : `${mix.b2c}% mix`}
				/>
				<KpiTile
					label="B2B Revenue"
					basis={revBasis}
					value={formatINR(kpi.b2b_revenue)}
					explain={revEx("b2b", kpi.b2b_revenue)}
					accent="amber"
					delta={b2bDelta}
					meta={mix.b2b == null ? undefined : `${mix.b2b}% mix`}
				/>
				<KpiTile
					label="Unclassified Rev"
					basis={revBasis}
					value={formatINR(kpi.unclassified_revenue)}
					explain={revEx("unclassified", kpi.unclassified_revenue)}
					accent={uncShareAbs > 0.2 ? "amber" : "default"}
					delta={uncDelta}
					meta={mix.unclassified == null ? undefined : `${mix.unclassified}% mix · no sales intent`}
					comingSoon={cs.unclassified_rev}
				/>
				<KpiTile
					label="Active SKUs"
					value={formatNumber(kpi.active_skus)}
					accent="blue"
					meta="items with sales"
					comingSoon={cs.active_skus}
				/>
			</div>

			<div className="sec-label mt-5">Profit ladder — {inPeriod} · ex-tax</div>
			<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2.5">
				<KpiTile
					label="CM1 · Gross Margin"
					basis="ex-tax"
					value={formatMargin(kpi.cm1_pct)}
					valueTitle={marginTitle(kpi.cm1_pct)}
					explain={ex("cm1")}
					accent={marginAccent(kpi.cm1_pct, 2)}
					meta={`Rev − cost of goods − direct · ${formatNumber(kpi.gross_margin_coverage_pct)}% valuated`}
				/>
				<KpiTile
					label="CM2 · Before marketing"
					basis="ex-tax"
					value={formatMargin(kpi.cm2_pct)}
					valueTitle={marginTitle(kpi.cm2_pct)}
					explain={ex("cm2")}
					accent={marginAccent(kpi.cm2_pct, 2)}
					meta={`CM1 − ${formatINR(kpi.cm2_deduction)} variable`}
				/>
				<KpiTile
					label="CM3 · After marketing"
					basis="ex-tax"
					value={formatMargin(kpi.cm3_pct)}
					valueTitle={marginTitle(kpi.cm3_pct)}
					explain={ex("cm3")}
					accent={marginAccent(kpi.cm3_pct, 2)}
					meta={`CM2 − ${formatINR(kpi.cm3_deduction)} marketing`}
				/>
				<KpiTile
					label="EBITDA"
					basis="ex-tax"
					value={formatMargin(kpi.ebitda_pct)}
					valueTitle={marginTitle(kpi.ebitda_pct)}
					explain={ex("ebitda")}
					accent={marginAccent(kpi.ebitda_pct, 5)}
					meta={
						cs.operating_opex
							? "CM3 − operating opex − other − internal (net)"
							: `CM3 − ${formatINR(li.operating_total)} opex ${signed(li.other_net_total)} other${li.internal_total ? ` ${signed(li.internal_total)} internal` : ""}`
					}
					comingSoon={cs.ebitda}
				/>
				<KpiTile
					label="EBIT"
					basis="ex-tax"
					value={formatMargin(kpi.ebit_pct)}
					valueTitle={marginTitle(kpi.ebit_pct)}
					explain={ex("ebit")}
					accent={marginAccent(kpi.ebit_pct, 5)}
					meta={li.da_total > 0 ? `EBITDA − ${formatINR(li.da_total)} D&A` : `no D&A booked in ${inPeriod}`}
					comingSoon={cs.ebit}
				/>
			</div>

			<div className="mt-2.5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2.5">
				<KpiTile
					label="PAT"
					basis="ex-tax"
					value={formatMargin(kpi.pat_pct)}
					valueTitle={marginTitle(kpi.pat_pct)}
					explain={patEx}
					accent={marginState(kpi.pat_pct) !== "ok" ? "amber" : (kpi.pat_pct ?? 0) > 0 ? "green" : "red"}
					meta={`${formatINR(kpi.pat)} · − ${amt("interest_finance", li.interest_total)} int · ${amt("income_tax", li.tax_total)} tax`}
					comingSoon={cs.pat}
				/>
				<KpiTile
					label="Gross Profit"
					basis="ex-tax"
					value={formatINR(kpi.gross_profit)}
					explain={ex("cm1", "overall", { title: "Gross profit (CM1 in ₹)" })}
					accent={kpi.gross_profit > 0 ? "green" : "red"}
					meta={`CM1 in ₹ · ${inPeriod}`}
					comingSoon={cs.gross_profit}
				/>
				<KpiTile
					label="Operating Opex"
					basis="ex-tax"
					value={formatINR(li.operating_total)}
					explain={opexEx}
					meta={`sal ${formatINR(li.salary_total)} · rent ${formatINR(li.rent_total)}`}
					comingSoon={cs.operating_opex}
				/>
				<KpiTile
					label="Interest & Finance"
					basis="ex-tax"
					value={formatINR(li.interest_total)}
					explain={ex("interest", "overall", { value: formatINR(li.interest_total) })}
					accent={li.interest_total > 0 ? "amber" : "default"}
					meta={`${li.interest_accounts.length} account${li.interest_accounts.length === 1 ? "" : "s"}`}
					comingSoon={cs.interest_finance}
				/>
				<KpiTile
					label="Income Tax"
					basis="ex-tax"
					value={formatINR(li.tax_total)}
					explain={ex("tax", "overall", { value: formatINR(li.tax_total) })}
					meta={
						li.tax_total !== 0
							? `${li.tax_accounts.length} account${li.tax_accounts.length === 1 ? "" : "s"}`
							: `none booked in ${inPeriod}`
					}
					comingSoon={cs.income_tax}
				/>
			</div>

			<div className="mt-4">
				<MarginTile
					hideGp={cs.gross_profit}
					rows={[
						{
							label: "Overall",
							explain: ex("cm1", "overall", { title: "Overall gross margin (CM1)" }),
							gpPct: kpi.gross_margin_pct,
							gp: kpi.gross_profit,
							coverage: kpi.gross_margin_coverage_pct,
						},
						{
							label: "B2C",
							explain: ex("cm1", "b2c", { title: "B2C gross margin (CM1)" }),
							gpPct: kpi.b2c_gross_margin_pct,
							gp: kpi.b2c_gross_profit,
							coverage: kpi.b2c_gross_margin_coverage_pct,
						},
						{
							label: "B2B",
							explain: ex("cm1", "b2b", { title: "B2B gross margin (CM1)" }),
							gpPct: kpi.b2b_gross_margin_pct,
							gp: kpi.b2b_gross_profit,
							coverage: kpi.b2b_gross_margin_coverage_pct,
						},
						{
							label: "Unclassified",
							explain: ex("cm1", "unclassified", { title: "Unclassified gross margin (CM1)" }),
							gpPct: kpi.unclassified_gross_margin_pct,
							gp: kpi.unclassified_gross_profit,
							coverage: kpi.unclassified_gross_margin_coverage_pct,
							hidden: cs.unclassified_rev,
						},
					]}
				/>
			</div>

			<LadderFootnote steps={res.pnl?.overall ?? []} ctx={ctx} flags={cs} glNetProfit={li.gl_net_profit} />
			<div className="mt-1 text-[10.5px] text-text-3 leading-[1.7]">
				<div>
					<span className="font-semibold text-text-2">Cost of goods split:</span> B2C / B2B / unclassified use
					each line's stock-ledger cost ({formatINR(li.cogs_allocated)}); the GL − stock-ledger difference of{" "}
					{formatINR(li.cogs_unallocated)} is unallocated cost of goods — shared by revenue across the buckets
					here, shown as its own line on the SKU and segment pages. Hover or tap any underlined figure for the
					ledgers behind it.
				</div>
				<div>
					<span className="font-semibold text-text-2">Basis:</span> {c2.allocation_basis} · scope{" "}
					{c2.company_scope} · edit in{" "}
					<a
						href="/app/company-dashboard-settings"
						className="text-green font-medium underline-offset-2 hover:underline"
					>
						Company Dashboard Settings
					</a>
					.
				</div>
			</div>

			{!cs.unclassified_rev && uncShareAbs > 0.1 && (
				<div className="mt-4 px-4 py-3 rounded-lg bg-amber-bg border border-amber/20 text-amber text-[12px] leading-relaxed flex items-start gap-2.5">
					<span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-amber text-white text-[10px] font-bold flex items-center justify-center">
						!
					</span>
					<div>
						<strong className="font-semibold">Heads up: </strong>
						{formatINR(kpi.unclassified_revenue)} ({mix.unclassified ?? "—"}%) of revenue is on items
						without a{" "}
						<code className="px-1 py-0.5 rounded bg-amber/10 text-[11px]">custom_sales_intent</code> set.
						Fill those in on the Item form to tighten the B2C/B2B split.
					</div>
				</div>
			)}

			<div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-4 mt-4">
				<div className="card">
					<div className="flex items-center justify-between mb-4">
						<div>
							<div className="card-title mb-0.5">Monthly revenue</div>
							<div className="text-[11px] text-text-3 font-medium">
								B2C · B2B · unclassified · ₹ · {revBasisLong}
							</div>
						</div>
						<span className="badge bg-green-bg text-green font-semibold">
							<span className="w-1.5 h-1.5 rounded-full bg-green mr-1.5 animate-pulse" />
							Live ERPNext
						</span>
					</div>
					{monthly.length === 0 ? (
						<EmptyState message="No Sales Invoice data in this period." />
					) : (
						<RevenueTrendChart data={monthly} hideUnclassified={cs.unclassified_rev} />
					)}
				</div>
				<div className="flex flex-col gap-4">
					<div className="card flex-1">
						<div className="card-title">Revenue mix · {revBasis}</div>
						<RevenueMixChart
							slices={[
								{ name: "B2C", value: kpi.b2c_revenue, share: mix.b2c, color: "#1F5F33" },
								{ name: "B2B", value: kpi.b2b_revenue, share: mix.b2b, color: "#96560F" },
								{
									name: "Unclassified",
									value: kpi.unclassified_revenue,
									share: mix.unclassified,
									color: "#9E9382",
									hidden: cs.unclassified_rev,
								},
							]}
						/>
					</div>
					<div className="card flex-1">
						<div className="flex items-center justify-between mb-3">
							<div className="card-title mb-0">Revenue by category</div>
							<span className="text-[9.5px] tracking-[0.1em] uppercase text-text-3 font-medium">
								Top 10 + Other · {revBasis}
							</span>
						</div>
						{categories.length === 0 ? (
							<EmptyState message="No Item Group data yet." />
						) : (
							<CategoryTable data={categories} />
						)}
					</div>
				</div>
			</div>
		</>
	);
}

/** A deduction in a "CM3 − x − y" sentence: "− ₹1.22 Cr", or "+ ₹1.20 Cr" for a net credit. */
function signed(deduction: number): string {
	return `${deduction < 0 ? "+" : "−"} ${formatINR(Math.abs(deduction))}`;
}

function EmptyState({ message }: { message: string }) {
	return (
		<div className="h-[140px] flex items-center justify-center text-[12px] text-text-3">{message}</div>
	);
}

/** Explain wrapper for chips / inline figures; renders the child as-is when there's no content. */
function ChipExplain({
	content,
	children,
	underline = false,
}: {
	content: ExplainContent | undefined;
	children: React.ReactNode;
	underline?: boolean;
}) {
	if (!content) return <>{children}</>;
	return (
		<Explain content={content} underline={underline}>
			{children}
		</Explain>
	);
}

function growthExplain(
	label: string,
	bucket: PnlBucket,
	cur: number,
	prior: number,
	d: Delta,
	ctx: ExplainCtx,
	comparison: string,
	basis: string,
): ExplainContent {
	return {
		title: `${label} revenue growth`,
		context: ctx.periodLabel,
		value: d.unavailable ? "n/a" : d.label,
		valueSub: d.unavailable ? PRIOR_INCOMPLETE : comparison,
		formula: "(this period − same dates last year) ÷ |same dates last year|",
		formulaLive: prior ? `(${formatINR(cur)} − ${formatINR(prior)}) ÷ ${formatINR(Math.abs(prior))}` : undefined,
		componentsTitle: `Revenue · ${basis}`,
		components: [
			{ label: "This period", amount: cur },
			{ label: "Same dates last year", amount: prior },
		],
		notes: d.unavailable ? ["The prior window isn't fully covered by data, so growth isn't comparable."] : undefined,
		links: [
			{ label: "Open breakdown", href: ctx.buildHref("/mis/line/revenue", { bucket }) },
			{ label: "Invoices", href: ctx.buildHref("/mis/revenue", { bucket }) },
		],
	};
}
