import { useEffect, useState } from "react";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { DownloadButtons } from "@/components/widgets/DownloadButtons";
import { PnlTable } from "@/components/widgets/PnlTable";
import { PnlWaterfallChart } from "@/components/widgets/PnlWaterfallChart";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { DataQualityBanner } from "@/components/widgets/DataQualityBanner";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { MarginValue, SoonValue } from "@/components/widgets/MarginValue";
import { useOverview } from "@/hooks/useOverview";
import { useComingSoon } from "@/hooks/useUiFlags";
import { bucketHidden, buildPnlSteps, stepsLookImpossible, type PnlBucket } from "@/lib/pnl";
import { cn, costExceedsRevenue, formatINR } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { OverviewResponse } from "@/types/mis";

const BUCKETS: Array<{ key: PnlBucket; label: string }> = [
	{ key: "overall", label: "Total" },
	{ key: "b2c", label: "B2C" },
	{ key: "b2b", label: "B2B" },
	{ key: "unclassified", label: "Unclassified" },
];

export function PnlPage({ query, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const [bucket, setBucket] = useState<PnlBucket>("overall");
	const { data, error, isLoading } = useOverview(query);
	const res = data?.message;
	const flags = useComingSoon();

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const activeBucket: PnlBucket = bucketHidden(bucket, flags) ? "overall" : bucket;

	const shell = (children: React.ReactNode, r?: OverviewResponse) => (
		<Shell
			query={query}
			onPeriodChange={onPeriodChange}
			res={r}
			bucket={activeBucket}
			onRefreshed={onRefreshed}
		>
			{children}
		</Shell>
	);

	if (isLoading && !res) {
		return shell(
			<div className="animate-pulse space-y-4">
				<div className="h-24 bg-surface-2 rounded-[12px]" />
				<div className="h-96 bg-surface-2 rounded-[12px]" />
			</div>,
		);
	}
	if (error || !res) {
		return shell(
			<ErrorCard
				title="Unable to load P&L"
				error={error ?? "The server returned no data."}
				period={query.period}
				onPeriodChange={onPeriodChange}
			/>,
		);
	}

	const steps = buildPnlSteps(res, activeBucket, flags);
	const impossible = (["overall", "b2c", "b2b", "unclassified"] as PnlBucket[]).some((b) =>
		stepsLookImpossible(res.pnl?.[b] ?? []),
	);

	return shell(
		<>
			<DataQualityBanner
				dq={res.data_quality}
				impossibleMargins={impossible}
				costOverRevenue={costExceedsRevenue(res.kpi.cogs, res.kpi.total_revenue_excl)}
			/>

			<div className="flex items-center gap-1 p-1 rounded-full border border-border-md bg-surface w-fit mb-4 shadow-[0_1px_2px_rgba(40,30,15,.05)]">
				{BUCKETS.map((b) => {
					const hidden = bucketHidden(b.key, flags);
					return (
						<button
							key={b.key}
							type="button"
							disabled={hidden}
							title={hidden ? "Coming soon — admin can enable in Company Dashboard Settings" : undefined}
							onClick={() => setBucket(b.key)}
							className={cn(
								"px-3.5 py-[5px] text-[11px] font-semibold rounded-full transition-all tracking-wide",
								activeBucket === b.key
									? "bg-green text-white shadow-[0_1px_2px_rgba(31,95,51,.25)]"
									: "text-text-2 hover:bg-surface-2",
								hidden && "opacity-50 cursor-not-allowed hover:bg-transparent",
							)}
						>
							{b.label}
							{hidden && <span className="ml-1 text-[9px] uppercase text-amber">soon</span>}
						</button>
					);
				})}
			</div>

			<BucketSplit res={res} />

			<div className="grid grid-cols-[1.4fr_1fr] gap-4">
				<div className="card">
					<div className="flex items-center justify-between mb-3">
						<div>
							<div className="card-title mb-0.5">P&amp;L Waterfall</div>
							<div className="text-[11px] text-text-3 font-medium">
								Revenue → PAT · {BUCKETS.find((b) => b.key === activeBucket)?.label} · % of ex-tax revenue
							</div>
						</div>
					</div>
					<PnlWaterfallChart steps={steps} />
				</div>
				<PnlTable steps={steps} />
			</div>

			<div className="mt-3 text-[10.5px] text-text-3 leading-[1.7]">
				{!flags.pat && (
					<div>
						<span className="font-semibold text-text-2">Tie-out:</span> PAT ties to GL net profit{" "}
						{formatINR(res.ladder_inputs.gl_net_profit)} (residual {formatINR(res.kpi.pat_residual)}).
					</div>
				)}
				{res.ladder_inputs.revenue_gl_difference != null &&
					Math.abs(res.ladder_inputs.revenue_gl_difference) >= 1 && (
						<div className="text-amber">
							Invoice revenue differs from the Sales GL ({formatINR(res.ladder_inputs.sales_gl)}) by{" "}
							{formatINR(res.ladder_inputs.revenue_gl_difference)}.
						</div>
					)}
				<div>
					B2C / B2B / unclassified lines below cost of goods are shared by ex-tax revenue (
					{res.cm2_inputs.allocation_basis}). Hover a line for the accounts behind it.
				</div>
			</div>
		</>,
		res,
	);
}

/** B2C + B2B + Unclassified = Total, for revenue and PAT (F5). */
function BucketSplit({ res }: { res: OverviewResponse }) {
	const flags = useComingSoon();
	const cols: Array<{ key: PnlBucket; label: string }> = [
		{ key: "b2c", label: "B2C" },
		{ key: "b2b", label: "B2B" },
		{ key: "unclassified", label: "Unclassified" },
		{ key: "overall", label: "Total" },
	];
	const pick = (b: PnlBucket, key: "revenue" | "cm1" | "pat") => res.pnl?.[b]?.find((s) => s.key === key);
	const rows: Array<{ key: "revenue" | "cm1" | "pat"; label: string; hidden: boolean; amountHidden: boolean }> = [
		{ key: "revenue", label: "Revenue (ex-tax)", hidden: false, amountHidden: false },
		{ key: "cm1", label: "CM1 · Gross margin", hidden: false, amountHidden: flags.gross_profit },
		{ key: "pat", label: "PAT", hidden: flags.pat, amountHidden: false },
	];
	return (
		<div className="card !p-0 overflow-hidden mb-4">
			<table className="w-full text-[12px] tabular-nums">
				<thead>
					<tr>
						<th className="px-5 py-2 text-left text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 border-b border-border">
							Split
						</th>
						{cols.map((c) => (
							<th
								key={c.key}
								className="px-3 py-2 text-right text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 border-b border-border"
							>
								{c.key === "overall" ? "= Total" : c.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.key} className="border-b border-border last:border-b-0">
							<td className="px-5 py-2 text-text-2 font-medium">{r.label}</td>
							{cols.map((c) => {
								const step = pick(c.key, r.key);
								const hidden = r.hidden || bucketHidden(c.key, flags);
								return (
									<td
										key={c.key}
										className={cn(
											"px-3 py-2 text-right",
											c.key === "overall" && "font-semibold bg-surface-2",
											step && step.subtotal < 0 && "text-red",
										)}
									>
										{hidden ? (
											<SoonValue />
										) : (
											<>
												<div>{r.amountHidden ? <SoonValue /> : formatINR(step?.subtotal)}</div>
												{r.key !== "revenue" && (
													<div className="text-[10px] text-text-3">
														<MarginValue pct={step?.pct ?? null} />
													</div>
												)}
											</>
										)}
									</td>
								);
							})}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function Shell({
	query,
	onPeriodChange,
	res,
	bucket,
	onRefreshed,
	children,
}: {
	query: MisPageProps["query"];
	onPeriodChange: MisPageProps["onPeriodChange"];
	res?: OverviewResponse;
	bucket: PnlBucket;
	onRefreshed: () => void;
	children: React.ReactNode;
}) {
	const flags = useComingSoon();
	const steps = res?.pnl?.[bucket] ?? [];
	const pat = steps.find((s) => s.key === "pat");
	return (
		<>
			{res && (
				<PreparedReportHeader
					refreshedAt={res.refreshed_at}
					stale={res.stale}
					section="mis"
					onRefreshed={onRefreshed}
				/>
			)}
			<header className="flex justify-between items-start mb-7 gap-4">
				<div>
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						P&amp;L Waterfall · ex-tax
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
						{res?.company ?? (query.company || "Profit & Loss")}
					</h1>
					{res && (
						<div className="text-[12px] text-text-2 mt-1.5 font-medium">
							{res.period.label} · every line tax-exclusive (the tax-mode switch only changes revenue on
							other pages)
						</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-2.5">
					<div className="flex items-center gap-2 flex-wrap justify-end">
						<DownloadButtons taxMode={query.taxMode} period={query.period} company={query.company} />
						<PeriodPicker value={query.period} onChange={onPeriodChange} company={query.company} />
						<span
							className="badge bg-surface border border-border-md text-text-2 font-semibold"
							title="The P&L is always built on tax-exclusive revenue"
						>
							Ex-tax basis
						</span>
					</div>
					{pat && (
						<div className="text-right">
							<div className="text-[10px] font-semibold tracking-[0.12em] uppercase text-text-3">PAT</div>
							{flags.pat ? (
								<div className="text-[20px] py-1">
									<SoonValue className="text-[12px]" />
								</div>
							) : (
								<>
									<div
										className={cn(
											"text-[30px] font-semibold leading-[1.05] tracking-tight tabular-nums",
											pat.subtotal >= 0 ? "text-text" : "text-red",
										)}
									>
										{formatINR(pat.subtotal)}
									</div>
									<div className="text-[12px] font-medium tabular-nums">
										<MarginValue
											pct={pat.pct}
											colorFor={(p) => (p >= 0 ? "text-green" : "text-red")}
										/>{" "}
										<span className="text-text-3">of ex-tax revenue</span>
									</div>
								</>
							)}
						</div>
					)}
				</div>
			</header>
			{children}
		</>
	);
}
