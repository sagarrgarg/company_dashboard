/** /mis/statement — monthly P&L statement (CM ladder × months, ex-tax), ₹ lakh or
 *  common-size %. Every cell explains itself and opens its line drill for that month. */
import { Fragment, useEffect } from "react";
import { DrillHeader, DrillSkeleton, SegTabs } from "@/components/drill/DrillLayout";
import { Explain } from "@/components/explain/Explain";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { TieBadge } from "@/components/statements/StatementBits";
import { usePnlStatement } from "@/hooks/useFinance";
import {
	explainStatementCell,
	explainStatementChecks,
	statementCellHref,
	type StatementColumn,
} from "@/lib/statements";
import { useDashState, useUrlParam } from "@/lib/urlState";
import { cn, formatINR, formatNumber, formatPct, formatUnit, isNil, UNIT_LABEL } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { PnlStatementResponse, StatementRow } from "@/types/finance";

type View = "amount" | "pct";
const VIEWS: readonly View[] = ["amount", "pct"] as const;

const GROUP_LABEL: Record<string, string> = {
	variable: "Variable selling costs",
	operating: "Operating expenses",
};

export function PnlStatementPage({ query, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const [view, setView] = useUrlParam<View>("view", "amount", VIEWS);
	const { data, error, isLoading } = usePnlStatement(query);
	const st = data?.message;

	useEffect(() => {
		if (st) onLoaded(st.company);
	}, [st, onLoaded]);

	const header = (
		<>
			<PreparedReportHeader refreshedAt={st?.refreshed_at} stale={st?.stale} section="mis" onRefreshed={onRefreshed} />
			<DrillHeader
				eyebrow={`Statements · Profit & loss · ex-tax · ${view === "pct" ? "% of revenue" : UNIT_LABEL.lakh}`}
				title="Profit & loss statement"
				subtitle={st ? `${st.period.label} · ${st.company}` : undefined}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
				right={
					<div className="flex flex-wrap items-center gap-2 md:justify-end">
						{st && (
							<TieBadge
								ok={st.checks.months_sum_to_total && st.checks.pat_equals_gl}
								content={explainStatementChecks(st)}
							>
								{st.checks.months_sum_to_total ? "✓" : "⚠"} months add up · {st.checks.pat_equals_gl ? "✓" : "⚠"} PAT = GL
							</TieBadge>
						)}
						<SegTabs
							label="Show amounts or common-size"
							value={view}
							onChange={setView}
							options={[
								{ key: "amount", label: "₹ lakh" },
								{ key: "pct", label: "% of revenue" },
							]}
						/>
					</div>
				}
			/>
		</>
	);

	if (isLoading && !st) return (<>{header}<DrillSkeleton /></>);
	if (error || !st) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load the P&L statement" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}
	return (
		<>
			{header}
			<StatementTable st={st} view={view} />
		</>
	);
}

function StatementTable({ st, view }: { st: PnlStatementResponse; view: View }) {
	const { buildHref } = useDashState();
	const hasPrior = st.rows.some((r) => r.prior_total != null);
	const cols: StatementColumn[] = [
		...st.months.map((m) => ({ kind: "month" as const, month: m })),
		{ kind: "total" },
		...(hasPrior ? ([{ kind: "prior" }, { kind: "change" }] as StatementColumn[]) : []),
	];
	const anyPartial = st.months.some((m) => m.partial);

	const revPrior = st.rows.find((r) => r.key === "revenue")?.prior_total ?? null;
	const priorPct = (r: StatementRow) => (r.prior_total != null && revPrior ? (r.prior_total / revPrior) * 100 : null);

	const cellText = (r: StatementRow, c: StatementColumn): string => {
		if (view === "pct") {
			if (c.kind === "prior") return fmtPct(priorPct(r));
			if (c.kind === "change") {
				const pp = priorPct(r);
				return pp == null || r.total_pct == null ? "—" : `${formatNumber(r.total_pct - pp, 1)} pp`;
			}
			const v = c.kind === "month" ? r.values[c.month.key] : r.total;
			const p = c.kind === "month" ? r.pct[c.month.key] : r.total_pct;
			return p == null ? "—" : isNil(v) ? "–" : formatPct(p);
		}
		const v = c.kind === "month" ? r.values[c.month.key] : c.kind === "total" ? r.total : c.kind === "prior" ? r.prior_total : r.change;
		if (v == null) return "—";
		return isNil(v) ? "–" : formatUnit(v);
	};

	let lastGroup: string | null = null;
	return (
		<div className="card !p-0 overflow-hidden">
			<div className="overflow-x-auto overscroll-x-contain">
				<table className="stmt-table w-full text-[12px]">
					<thead>
						<tr>
							<th className="stmt-sticky text-left px-3 md:px-4 py-2.5 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 min-w-[150px] md:min-w-[220px]">
								{view === "pct" ? "% of revenue" : UNIT_LABEL.lakh}
							</th>
							{cols.map((c) => (
								<th
									key={colKey(c)}
									className={cn(
										"px-2.5 py-2.5 text-right text-[10px] font-semibold tracking-[0.06em] uppercase text-text-3",
										c.kind === "month" && c.month.partial && "stmt-partial",
										c.kind === "total" && "text-text bg-surface-2/60",
									)}
									title={c.kind === "month" && c.month.partial ? "Partial month — only the days inside the period" : undefined}
									scope="col"
								>
									{c.kind === "month" ? (
										<>
											{c.month.label}
											{c.month.partial && <span aria-label="partial month">*</span>}
										</>
									) : c.kind === "total" ? (
										"Total"
									) : c.kind === "prior" ? (
										"PY total"
									) : (
										"Δ vs PY"
									)}
								</th>
							))}
							{hasPrior && (
								<th className="px-2.5 py-2.5 text-right text-[10px] font-semibold tracking-[0.06em] uppercase text-text-3">Δ %</th>
							)}
						</tr>
					</thead>
					<tbody>
						{st.rows.map((r, i) => {
							const groupRow = r.group && r.group !== lastGroup ? r.group : null;
							lastGroup = r.kind === "deduction" ? r.group : null;
							const tier = r.kind !== "deduction";
							return (
								<Fragment key={r.key}>
									{groupRow && (
										<tr className="stmt-group">
											<td className="stmt-sticky px-3 md:px-4 pt-3 pb-1 text-[9.5px] font-semibold tracking-[0.12em] uppercase text-text-3">
												{GROUP_LABEL[groupRow] ?? groupRow}
											</td>
											<td colSpan={cols.length + (hasPrior ? 1 : 0)} />
										</tr>
									)}
									<tr className={cn(r.kind === "tier" && "stmt-tier", r.key === "pat" && "stmt-final")}>
										<th
											scope="row"
											className={cn(
												"stmt-sticky text-left py-1.5 pr-3 font-normal",
												r.kind === "deduction" ? "pl-6 md:pl-8 text-text-2" : "pl-3 md:pl-4 font-semibold text-text",
											)}
										>
											<span className="leading-snug">{r.label}</span>
										</th>
										{cols.map((c) => {
											const v = c.kind === "month" ? r.values[c.month.key] : c.kind === "total" ? r.total : c.kind === "prior" ? r.prior_total : r.change;
											const tone =
												c.kind === "change"
													? (r.change ?? 0) > 0.5
														? "text-green"
														: (r.change ?? 0) < -0.5
															? "text-red"
															: "text-text-3"
													: tier && (v ?? 0) < -0.5
														? "text-red"
														: isNil(v)
															? "text-text-4"
															: "";
											const text = cellText(r, c);
											return (
												<td
													key={colKey(c)}
													className={cn(
														"px-2.5 py-1.5 text-right",
														c.kind === "total" && "bg-surface-2/40 font-semibold",
														c.kind === "month" && c.month.partial && "stmt-partial",
														tone,
													)}
												>
													<Explain
														content={() => explainStatementCell(st, i, c, buildHref)}
														href={statementCellHref(buildHref, r, c, st)}
														underline={false}
														label={`${r.label}, ${colLabel(c)}, ${text}`}
													>
														{text}
													</Explain>
												</td>
											);
										})}
										{hasPrior && (
											<td
												className={cn(
													"px-2.5 py-1.5 text-right",
													r.change_pct == null ? "text-text-4" : r.change_pct > 0 ? "text-green" : r.change_pct < 0 ? "text-red" : "text-text-3",
												)}
											>
												{r.change_pct == null ? "—" : (
													<Explain content={() => explainStatementCell(st, i, { kind: "change" }, buildHref)} underline={false} label={`${r.label}, change ${formatPct(r.change_pct)}`}>
														{formatPct(r.change_pct)}
													</Explain>
												)}
											</td>
										)}
									</tr>
								</Fragment>
							);
						})}
					</tbody>
				</table>
			</div>
			<div className="px-4 md:px-5 py-3 border-t border-border text-[10.5px] text-text-3 leading-relaxed">
				{view === "pct" ? "Common-size: each line as % of that column's ex-tax revenue (Δ in percentage points). " : `Amounts in ${UNIT_LABEL.lakh} (en-IN grouping); hover a figure for the exact rupees. `}
				Deductions are negative — a positive deduction is a net credit. Click any figure to open its ledgers for that month in a new tab.
				{anyPartial && " * Partial month: only the days inside the period."}
				{!hasPrior && st.period.prior.available === false && (
					<> Prior-year columns hidden: the same period last year isn't fully covered by data ({formatPct(st.period.prior.coverage_pct, 0)} covered).</>
				)}
				{" "}Revenue {formatINR(st.rows[0]?.total)} · PAT {formatINR(st.checks.pat)}.
			</div>
		</div>
	);
}

const fmtPct = (p: number | null) => (p == null ? "—" : formatPct(p));

function colKey(c: StatementColumn): string {
	return c.kind === "month" ? c.month.key : c.kind;
}

function colLabel(c: StatementColumn): string {
	return c.kind === "month" ? `${c.month.label}${c.month.partial ? " (partial)" : ""}` : c.kind === "total" ? "total" : c.kind === "prior" ? "prior year" : "change";
}
