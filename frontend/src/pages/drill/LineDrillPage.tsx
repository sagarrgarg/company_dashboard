/** /mis/line/:key?bucket=… — one P&L line: value, formula with live values, the parts
 *  (tiers) or every ledger (deductions / revenue), and its monthly trend. */
import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import {
	Breadcrumbs,
	DrillHeader,
	DrillSkeleton,
	DrillTh,
	ExtLink,
	MonthlyBars,
	SegTabs,
	StatTile,
	type Crumb,
} from "@/components/drill/DrillLayout";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { useOverview } from "@/hooks/useOverview";
import { usePnlStatement } from "@/hooks/useFinance";
import { useComingSoon } from "@/hooks/useUiFlags";
import { useExplainCtx } from "@/hooks/useExplainCtx";
import { BUCKETS, STEP_FLAG, bucketHidden, isStepKey, ladderLabel, parentTier } from "@/lib/pnl";
import {
	BUCKET_LABEL,
	deskAccountHref,
	explainStep,
	sourcesTarget,
	stepValue,
} from "@/lib/explain";
import { useDashState, useUrlParam, type DashStateApi } from "@/lib/urlState";
import type { ExplainCtx } from "@/lib/explain";
import type { PnlStatementResponse } from "@/types/finance";
import { cn, formatINR, formatMargin, formatPct } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { ApiPnlStep, OverviewResponse, PnlBucket, PnlStepKey } from "@/types/mis";

export function LineDrillPage({ query, onPeriodChange, onLoaded }: MisPageProps) {
	const { key: rawKey } = useParams();
	const key = (isStepKey(rawKey) ? rawKey : null) as PnlStepKey | null;
	const [bucket, setBucket] = useUrlParam<PnlBucket>("bucket", "overall", BUCKETS);
	const flags = useComingSoon();
	const { data, error, isLoading } = useOverview(query);
	const res = data?.message;
	const statement = usePnlStatement(query, Boolean(key));
	const ctx = useExplainCtx(res?.period, res?.company, bucket);
	const { drillTo } = useDashState();

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const step: ApiPnlStep | undefined = key ? res?.pnl?.[bucket]?.find((s) => s.key === key) : undefined;
	const label = step?.label ?? (key ? ladderLabel(key) : "Unknown line");
	const tier = key ? parentTier(key) : null;
	const bucketExtra = { bucket: bucket === "overall" ? null : bucket };

	const crumbs: Crumb[] = [{ label: "Overview", path: "/mis" }];
	if (tier) crumbs.push({ label: shortLabel(ladderLabel(tier)), path: `/mis/line/${tier}`, extra: bucketExtra });
	crumbs.push({ label: shortLabel(label) });

	const flag = key ? STEP_FLAG[key] : undefined;
	const hidden = Boolean(flag && flags[flag]) || (key === "cm1" && flags.gross_profit) || bucketHidden(bucket, flags);

	const header = (
		<>
			<Breadcrumbs items={crumbs} />
			<DrillHeader
				eyebrow={`P&L line · ${BUCKET_LABEL[bucket]} · ex-tax`}
				title={label}
				subtitle={res?.period.label}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
				right={
					<SegTabs
						label="Revenue bucket"
						value={bucket}
						onChange={setBucket}
						options={BUCKETS.map((b) => ({
							key: b,
							label: BUCKET_LABEL[b],
							disabled: bucketHidden(b, flags),
						}))}
					/>
				}
			/>
		</>
	);

	if (!key) {
		return (
			<>
				{header}
				<ErrorCard title="Unknown P&L line" error={`No P&L line called "${rawKey ?? ""}".`} />
			</>
		);
	}
	if (isLoading && !res) return (<>{header}<DrillSkeleton /></>);
	if (error || !res) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load the P&L" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}
	if (hidden || !step) {
		return (
			<>
				{header}
				<div className="card text-[13px] text-text-2">
					{hidden ? "Coming soon — an admin can enable this figure in Company Dashboard Settings." : "This line isn't in the ladder for this bucket."}
				</div>
			</>
		);
	}

	return (
		<>
			{header}
			<LineBody step={step} bucket={bucket} res={res} ctx={ctx} statement={statement.data?.message} statementError={statement.error} drillTo={drillTo} />
		</>
	);
}

function LineBody({
	step,
	bucket,
	res,
	ctx,
	statement,
	statementError,
	drillTo,
}: {
	step: ApiPnlStep;
	bucket: PnlBucket;
	res: OverviewResponse;
	ctx: ExplainCtx;
	statement: PnlStatementResponse | undefined;
	statementError: unknown;
	drillTo: DashStateApi["drillTo"];
}) {
	const content = useMemo(() => explainStep(step, ctx, { maxSources: Number.POSITIVE_INFINITY }), [step, ctx]);
	const steps = res.pnl[bucket];
	const revenue = steps.find((s) => s.key === "revenue")?.amount ?? 0;
	const value = stepValue(step);
	const bucketExtra = { bucket: bucket === "overall" ? null : bucket };
	const isDeduction = step.kind === "deduction";
	const sources = [...(step.sources ?? [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
	const target = sourcesTarget(step);
	const accounts = sources.map((s) => s.account).filter((a): a is string => !!a);

	const row = statement?.rows.find((r) => r.key === step.key);
	const trend = (statement?.months ?? []).map((m) => {
		const v = row?.values[m.key] ?? 0;
		return { key: m.key, label: m.label, value: isDeduction ? -v : v, partial: m.partial };
	});

	return (
		<>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4">
				<StatTile
					label={isDeduction ? "Amount (cost)" : "Amount"}
					value={formatINR(isDeduction ? -value : value)}
					tone={!isDeduction && value < 0 ? "red" : "default"}
					sub={isDeduction ? "reduces the ladder" : step.kind === "tier" ? "running total" : "ex-tax, net of returns"}
				/>
				<StatTile label="% of revenue" value={formatMargin(step.pct)} sub={`of ${formatINR(revenue)} ex-tax revenue`} />
				<StatTile
					label={step.kind === "tier" ? "Parts" : "Ledgers"}
					value={String(step.kind === "tier" ? (step.components ?? []).length : sources.length)}
					sub={step.share != null ? `${formatPct(step.share * 100)} revenue share` : BUCKET_LABEL[bucket]}
				/>
				<StatTile label="Tie-out" sub={<span className="text-[10.5px] text-text-3">client-side check</span>}>
					{content.check && (
						<div className={cn("kpi-val text-[15px] mt-1", content.check.ok ? "text-green" : "text-amber")}>
							{content.check.ok ? "✓ ties" : "⚠ off"}
						</div>
					)}
				</StatTile>
			</div>

			<div className="card mb-4">
				<div className="card-title">How it's calculated</div>
				{content.formula && <div className="text-[13px] text-text-2 font-medium">{content.formula}</div>}
				{content.formulaLive && <div className="text-[13px] text-text tabular-nums mt-1 break-words">{content.formulaLive}</div>}
				{content.check && (
					<div className={cn("mt-2 inline-flex text-[11.5px] font-semibold px-2 py-1 rounded-md", content.check.ok ? "bg-green-bg text-green" : "bg-amber-bg text-amber")}>
						{content.check.text}
					</div>
				)}
				{(content.notes ?? []).map((n, i) => (
					<div key={i} className="text-[11px] text-text-3 mt-1.5">{n}</div>
				))}
				<div className="flex flex-wrap gap-2 mt-3">
					{step.key === "revenue" && (
						<Link
							to={drillTo("/mis/revenue", bucketExtra)}
							className="inline-flex items-center min-h-[32px] px-3 rounded-full bg-green text-white text-[11.5px] font-semibold hover:bg-green-mid"
						>
							Invoices behind this revenue →
						</Link>
					)}
					{accounts.length > 0 && ctx.glHref && <ExtLink href={ctx.glHref(accounts)}>Open in ERPNext GL</ExtLink>}
				</div>
			</div>

			<div className="grid grid-cols-1 xl:grid-cols-[1.25fr_1fr] gap-4">
				{step.kind === "tier" ? (
					<div className="card !p-0 overflow-hidden">
						<div className="px-5 pt-4 pb-3 border-b border-border card-title !mb-0">Built from</div>
						<table className="drill-table w-full text-[12.5px] tabular-nums">
							<thead>
								<tr>
									<DrillTh align="left">Line</DrillTh>
									<DrillTh>₹</DrillTh>
									<DrillTh>% revenue</DrillTh>
								</tr>
							</thead>
							<tbody>
								{(step.components ?? []).map((c, i) => (
									<tr key={c.key} className="border-b border-border">
										<td className="drill-primary px-5 py-2">
											<span className="text-text-3 w-3 inline-block">{i === 0 ? "" : c.amount > 0 ? "+" : "−"}</span>
											<Link to={drillTo(`/mis/line/${c.key}`, bucketExtra)} className="text-green hover:underline underline-offset-2">
												{c.label}
											</Link>
										</td>
										<td data-label="₹" className="px-3 py-2 text-right">{formatINR(i === 0 ? c.amount : Math.abs(c.amount))}</td>
										<td data-label="% revenue" className="px-3 py-2 text-right text-text-3">
											{revenue ? formatPct((c.amount / revenue) * 100) : "—"}
										</td>
									</tr>
								))}
								<tr className="bg-surface-2 font-semibold">
									<td className="drill-primary px-5 py-2">= {step.label}</td>
									<td data-label="₹" className={cn("px-3 py-2 text-right", value < 0 && "text-red")}>{formatINR(value)}</td>
									<td data-label="% revenue" className="px-3 py-2 text-right">{formatMargin(step.pct)}</td>
								</tr>
							</tbody>
						</table>
					</div>
				) : (
					<div className="card !p-0 overflow-hidden">
						<div className="px-5 pt-4 pb-3 border-b border-border flex items-baseline justify-between gap-3">
							<div className="card-title !mb-0">{step.kind === "anchor" ? "Income accounts" : "Ledgers"}</div>
							<div className="text-[10px] text-text-3 uppercase tracking-[0.08em] font-semibold">
								{step.kind === "anchor" ? "Σ = revenue" : "+ adds cost · − nets it down"}
							</div>
						</div>
						{sources.length === 0 ? (
							<div className="px-5 py-6 text-[12px] text-text-3">No ledger is mapped to this line, or none moved in the period.</div>
						) : (
							<table className="drill-table w-full text-[12.5px] tabular-nums">
								<thead>
									<tr>
										<DrillTh align="left">Ledger</DrillTh>
										<DrillTh>₹</DrillTh>
										<DrillTh>% of line</DrillTh>
										<DrillTh>Desk</DrillTh>
									</tr>
								</thead>
								<tbody>
									{sources.map((s, i) => (
										<tr key={(s.account ?? s.label ?? "") + i} className="border-b border-border">
											<td className="drill-primary px-5 py-2 break-words">
												{s.account ? (
													<Link
														to={drillTo(`/mis/account/${encodeURIComponent(s.account)}`, { via: step.key, ...bucketExtra })}
														className="text-green hover:underline underline-offset-2"
													>
														{s.account}
													</Link>
												) : (
													<span className="text-text-2">{s.label}</span>
												)}
												{s.root_type && <span className="ml-1.5 text-[10px] text-text-4">{s.root_type}</span>}
											</td>
											<td data-label="₹" className={cn("px-3 py-2 text-right whitespace-nowrap", s.amount < 0 && "text-green")}>
												{formatINR(s.amount)}
											</td>
											<td data-label="% of line" className="px-3 py-2 text-right text-text-3">
												{Math.abs(target) >= 0.5 ? formatPct((s.amount / target) * 100) : "—"}
											</td>
											<td data-label="Desk" className="px-3 py-2 text-right whitespace-nowrap">
												{s.account ? (
													<span className="inline-flex gap-2">
														{step.key === "revenue" && (
															<Link to={drillTo("/mis/revenue", { income_account: s.account, ...bucketExtra })} className="text-green text-[11px] hover:underline">
																invoices
															</Link>
														)}
														<ExtLink href={deskAccountHref(s.account)} variant="inline" className="text-[11px]">account</ExtLink>
													</span>
												) : (
													<span className="text-text-4 text-[11px]">derived</span>
												)}
											</td>
										</tr>
									))}
									<tr className="bg-surface-2 font-semibold">
										<td className="drill-primary px-5 py-2">Σ {sources.length} {sources.length === 1 ? "ledger" : "ledgers"}</td>
										<td data-label="₹" className="px-3 py-2 text-right">{formatINR(sources.reduce((a, s) => a + s.amount, 0))}</td>
										<td data-label="% of line" className="px-3 py-2 text-right">100%</td>
										<td />
									</tr>
								</tbody>
							</table>
						)}
					</div>
				)}

				<div className="card">
					<div className="card-title mb-0.5">Monthly trend</div>
					<div className="text-[11px] text-text-3 font-medium mb-3">
						{isDeduction ? "Cost per month" : "Per month"} · ex-tax · dashed = month to date
						{bucket !== "overall" && " · whole company (the monthly statement isn't split by bucket)"}
					</div>
					{statementError ? (
						<div className="text-[12px] text-text-3">Monthly statement unavailable.</div>
					) : !statement ? (
						<div className="h-[200px] bg-surface-2 rounded-lg animate-pulse" />
					) : (
						<>
							<MonthlyBars data={trend} valueLabel={step.label} />
							{row && (
								<div className="text-[11px] text-text-3 mt-2 tabular-nums">
									Σ months {formatINR(isDeduction ? -row.total : row.total)}
									{statement.checks.months_sum_to_total ? " ✓ months sum to the total" : " ⚠ months don't sum to the total"}
									{row.prior_total != null && <> · prior year {formatINR(isDeduction ? -row.prior_total : row.prior_total)}</>}
								</div>
							)}
						</>
					)}
				</div>
			</div>
		</>
	);
}

/** "CM2 · Before marketing" → "CM2" for crumbs. */
function shortLabel(label: string): string {
	return label.split("·")[0]?.trim() || label;
}
