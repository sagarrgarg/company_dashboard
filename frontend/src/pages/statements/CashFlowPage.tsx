/** /mis/cash-flow — indirect-method cash flow (Ind AS 7): operating / investing /
 *  financing, net change, opening and closing cash, and the tie to balance-sheet cash.
 *  Rows explain (and expand to) the balance movements behind them. */
import { Fragment, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { DrillHeader, DrillSkeleton, StatTile } from "@/components/drill/DrillLayout";
import { Explain, canHover, useExplainController, wantsSheet } from "@/components/explain/Explain";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { TieBadge } from "@/components/statements/StatementBits";
import { useCashFlow } from "@/hooks/useFinance";
import { cfExplainCash, cfExplainNet, cfExplainRow, cfExplainSection, type BuildHref } from "@/lib/statements";
import type { ExplainContent } from "@/lib/explain";
import { useDashState } from "@/lib/urlState";
import { cn, formatINR, formatUnit, formatUnitINR, isNil, shortDate, UNIT_LABEL } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { CashFlowResponse } from "@/types/finance";

const SHORT: Record<string, string> = { operating: "Operating", investing: "Investing", financing: "Financing" };

export function CashFlowPage({ query, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const { data, error, isLoading } = useCashFlow(query);
	const cf = data?.message;
	const { buildHref } = useDashState();

	useEffect(() => {
		if (cf) onLoaded(cf.company);
	}, [cf, onLoaded]);

	const header = (
		<>
			<PreparedReportHeader refreshedAt={cf?.refreshed_at} stale={cf?.stale} section="mis" onRefreshed={onRefreshed} />
			<DrillHeader
				eyebrow={`Statements · Cash flow · indirect method (Ind AS 7) · ${UNIT_LABEL.lakh}`}
				title="Cash flow statement"
				subtitle={cf ? `${cf.period.label} · ${cf.company}` : undefined}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
				right={
					cf && (
						<div className="flex flex-wrap gap-2 md:justify-end">
							<TieBadge ok={cf.checks.ties_to_balance_sheet} tone={cf.checks.ties_to_balance_sheet ? "green" : "red"} content={() => cfExplainCash(cf, "closing", buildHref)}>
								{cf.checks.ties_to_balance_sheet ? "✓ Closing = balance-sheet cash" : `⚠ Off by ${formatINR(cf.checks.difference)}`}
							</TieBadge>
							<TieBadge ok={cf.checks.pat_equals_gl} content={() => patExplain(cf, buildHref)}>
								{cf.checks.pat_equals_gl ? "✓" : "⚠"} PAT = GL
							</TieBadge>
						</div>
					)
				}
			/>
		</>
	);

	if (isLoading && !cf) return (<>{header}<DrillSkeleton /></>);
	if (error || !cf) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load the cash flow" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}
	return (
		<>
			{header}
			<CashFlowBody cf={cf} buildHref={buildHref} />
		</>
	);
}

/** The PAT row that starts the operating section (falls back to the net change). */
function patExplain(cf: CashFlowResponse, buildHref: BuildHref): ExplainContent {
	const s = cf.sections.find((x) => x.key === "operating");
	const r = s?.rows.find((x) => x.key === "pat");
	if (!s || !r) return cfExplainNet(cf);
	const c = cfExplainRow(cf, s, r, buildHref);
	return {
		...c,
		check: { ok: cf.checks.pat_equals_gl, text: cf.checks.pat_equals_gl ? "PAT = GL net profit ✓" : "PAT ≠ GL net profit ⚠" },
	};
}

function CashFlowBody({ cf, buildHref }: { cf: CashFlowResponse; buildHref: BuildHref }) {
	const sec = (k: string) => cf.sections.find((s) => s.key === k);
	return (
		<>
			<div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-4">
				<StatTile label="Opening cash" sub={`before ${shortDate(cf.period.from)}`}>
					<TileValue v={cf.opening_cash} content={() => cfExplainCash(cf, "opening", buildHref)} label="Opening cash" />
				</StatTile>
				{(["operating", "investing", "financing"] as const).map((k) => {
					const s = sec(k);
					if (!s) return null;
					return (
						<StatTile key={k} label={`${SHORT[k]} (CF${k[0].toUpperCase()})`} sub={s.total >= 0 ? "net inflow" : "net outflow"}>
							<TileValue v={s.total} tone content={() => cfExplainSection(cf, s)} label={s.label} />
						</StatTile>
					);
				})}
				<StatTile
					label="Closing cash"
					sub={<span className={cf.checks.ties_to_balance_sheet ? "text-green" : "text-red"}>{cf.checks.ties_to_balance_sheet ? "= balance-sheet cash ✓" : "≠ balance-sheet cash ⚠"}</span>}
				>
					<TileValue v={cf.closing_cash} content={() => cfExplainCash(cf, "closing", buildHref)} label="Closing cash" />
				</StatTile>
			</div>

			<div className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-4 items-start">
				<CashFlowTable cf={cf} buildHref={buildHref} />
				<div className="card">
					<div className="card-title mb-0.5">Opening → closing cash</div>
					<div className="text-[11px] text-text-3 font-medium mb-3">{UNIT_LABEL.lakh} · hover or tap a bar for its breakdown</div>
					<CashWaterfall cf={cf} buildHref={buildHref} />
				</div>
			</div>

			<ol className="mt-3 text-[10.5px] text-text-3 leading-[1.7] list-decimal pl-4">
				<li>{cf.policy.od_treatment}</li>
				<li>{cf.policy.interest}</li>
				<li>
					Cash &amp; cash equivalents = {cf.cash_accounts.length} asset-side Bank / Cash accounts. Every balance-sheet line moves into exactly one
					section, so opening + net change = closing unless an entry is unbalanced. Account pages show debit − credit for the period; the cash
					effect is its opposite.
				</li>
			</ol>
		</>
	);
}

function TileValue({ v, content, label, tone = false }: { v: number; content: () => ExplainContent; label: string; tone?: boolean }) {
	return (
		<div className={cn("kpi-val text-[20px] md:text-[22px] break-words", tone && v < 0 && "text-red", tone && v > 0 && "text-green")}>
			<Explain content={content} label={`${label}, ${formatINR(v)}, has breakdown`}>
				{formatUnitINR(v)}
			</Explain>
		</div>
	);
}

function CashFlowTable({ cf, buildHref }: { cf: CashFlowResponse; buildHref: BuildHref }) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	return (
		<div className="card !p-0 overflow-hidden">
			<div className="overflow-x-auto">
			<table className="stmt-table w-full text-[12.5px]">
				<thead>
					<tr>
						<th className="text-left px-4 md:px-5 py-2.5 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">Indirect method</th>
						<th className="text-right px-4 md:px-5 py-2.5 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 w-[120px]">{UNIT_LABEL.lakh}</th>
					</tr>
				</thead>
				<tbody>
					{cf.sections.map((s) => (
						<Fragment key={s.key}>
							<tr className="stmt-group">
								<th colSpan={2} scope="rowgroup" className="text-left px-4 md:px-5 pt-3.5 pb-1.5 text-[9.5px] font-semibold tracking-[0.12em] uppercase text-text-3">
									{s.label}
								</th>
							</tr>
							{s.rows.map((r) => {
								const id = `${s.key}:${r.key}`;
								const isOpen = !!open[id];
								const accts = [...r.accounts].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
								return (
									<Fragment key={r.key}>
										<tr>
											<th scope="row" className="text-left pl-4 md:pl-5 pr-2 py-1.5 font-normal text-text whitespace-normal">
												{accts.length ? (
													<button
														type="button"
														onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
														aria-expanded={isOpen}
														className="flex items-center gap-1.5 text-left min-h-[24px] hover:text-green"
													>
														<span className={cn("text-[9px] text-text-4 transition-transform", isOpen && "rotate-90")} aria-hidden="true">▶</span>
														<span className="leading-snug">
															{r.label}
															<span className="ml-1 text-[10px] text-text-4">{accts.length}</span>
														</span>
													</button>
												) : (
													<span className="pl-4 leading-snug inline-block">{r.label}</span>
												)}
											</th>
											<td className={cn("px-4 md:px-5 py-1.5 text-right", r.amount < -0.5 && "text-red", isNil(r.amount) && "text-text-4")}>
												<Explain content={() => cfExplainRow(cf, s, r, buildHref)} underline={false} label={`${r.label}, ${formatINR(r.amount)}`}>
													{isNil(r.amount) ? "–" : formatUnit(r.amount)}
												</Explain>
											</td>
										</tr>
										{isOpen &&
											accts.map((a) => (
												<tr key={a.account} className="text-[11.5px]">
													<td className="pl-12 pr-2 py-1 text-text-2 whitespace-normal">
														<a
															href={buildHref(`/mis/account/${encodeURIComponent(a.account)}`, { via: "cf" })}
															target="_blank"
															rel="noopener"
															className="hover:text-green hover:underline underline-offset-2 break-words"
														>
															{a.account} <span className="text-text-4" aria-hidden="true">↗</span>
														</a>
													</td>
													<td className={cn("px-4 md:px-5 py-1 text-right text-text-2", a.amount < 0 && "text-red")}>{formatUnit(a.amount)}</td>
												</tr>
											))}
									</Fragment>
								);
							})}
							<tr className="stmt-tier">
								<th scope="row" className="text-left px-4 md:px-5 py-2 font-semibold text-text whitespace-normal">Net cash from {s.key} activities</th>
								<td className={cn("px-4 md:px-5 py-2 text-right", s.total < -0.5 ? "text-red" : "text-green")}>
									<Explain content={() => cfExplainSection(cf, s)} underline={false} label={`${s.label}, ${formatINR(s.total)}`}>
										{formatUnit(s.total)}
									</Explain>
								</td>
							</tr>
						</Fragment>
					))}
					<tr className="stmt-tier">
						<th scope="row" className="text-left px-4 md:px-5 py-2.5 font-semibold text-text">Net change in cash</th>
						<td className={cn("px-4 md:px-5 py-2.5 text-right", cf.net_change < -0.5 ? "text-red" : "text-green")}>
							<Explain content={() => cfExplainNet(cf)} underline={false} label={`Net change in cash, ${formatINR(cf.net_change)}`}>
								{formatUnit(cf.net_change)}
							</Explain>
						</td>
					</tr>
					<tr>
						<th scope="row" className="text-left px-4 md:px-5 py-2 font-normal text-text-2">Add: opening cash &amp; cash equivalents</th>
						<td className="px-4 md:px-5 py-2 text-right">
							<Explain content={() => cfExplainCash(cf, "opening", buildHref)} underline={false} label={`Opening cash, ${formatINR(cf.opening_cash)}`}>
								{formatUnit(cf.opening_cash)}
							</Explain>
						</td>
					</tr>
					<tr className="stmt-tier stmt-final">
						<th scope="row" className="text-left px-4 md:px-5 py-2.5 font-bold text-text">Closing cash &amp; cash equivalents</th>
						<td className="px-4 md:px-5 py-2.5 text-right font-bold">
							<Explain content={() => cfExplainCash(cf, "closing", buildHref)} underline={false} label={`Closing cash, ${formatINR(cf.closing_cash)}`}>
								{formatUnit(cf.closing_cash)}
							</Explain>
						</td>
					</tr>
				</tbody>
			</table>
			</div>
			<div className={cn("px-4 md:px-5 py-2.5 text-[11px] font-semibold", cf.checks.ties_to_balance_sheet ? "text-green bg-green-bg/50" : "text-red bg-red-bg/50")}>
				{cf.checks.ties_to_balance_sheet
					? `✓ Closing cash ties to the balance sheet on ${shortDate(cf.period.to)} (difference ${formatINR(cf.checks.difference)})`
					: `⚠ Closing cash differs from the balance sheet by ${formatINR(cf.checks.difference)}`}
			</div>
		</div>
	);
}

interface Step {
	key: string;
	label: string;
	range: [number, number];
	amount: number;
	kind: "total" | "delta";
	tag: string;
	content: () => ExplainContent;
}

/** Opening → CFO → CFI → CFF → closing as floating bars. */
function CashWaterfall({ cf, buildHref }: { cf: CashFlowResponse; buildHref: BuildHref }) {
	const ctl = useExplainController();
	const L = (v: number) => v / 1_00_000;
	const steps: Step[] = [
		{ key: "open", label: "Opening", range: [0, L(cf.opening_cash)], amount: cf.opening_cash, kind: "total", tag: formatUnit(cf.opening_cash), content: () => cfExplainCash(cf, "opening", buildHref) },
	];
	let run = cf.opening_cash;
	for (const s of cf.sections) {
		const next = run + s.total;
		steps.push({
			key: s.key,
			label: SHORT[s.key] ?? s.key,
			range: [L(Math.min(run, next)), L(Math.max(run, next))],
			amount: s.total,
			kind: "delta",
			tag: `${s.total >= 0 ? "+" : ""}${formatUnit(s.total)}`,
			content: () => cfExplainSection(cf, s),
		});
		run = next;
	}
	steps.push({ key: "close", label: "Closing", range: [0, L(cf.closing_cash)], amount: cf.closing_cash, kind: "total", tag: formatUnit(cf.closing_cash), content: () => cfExplainCash(cf, "closing", buildHref) });

	return (
		<ResponsiveContainer width="100%" height={260}>
			<BarChart data={steps} margin={{ top: 22, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
				<CartesianGrid stroke="rgba(40,30,15,.07)" vertical={false} />
				<XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 10, fill: "#7A6F5D", fontWeight: 600 }} />
				<YAxis tickLine={false} axisLine={false} width={56} tick={{ fontSize: 10, fill: "#7A6F5D" }} tickFormatter={(v) => formatUnit(Number(v) * 1_00_000, "lakh", 0)} />
				<Bar dataKey="range" isAnimationActive={false} radius={[3, 3, 3, 3]}>
					{steps.map((s) => {
						const id = `cfwf:${s.key}`;
						return (
							<Cell
								key={s.key}
								fill={s.kind === "total" ? "#2C4E80" : s.amount >= 0 ? "#1F5F33" : "#7A1F1F"}
								style={{ cursor: "pointer" }}
								onMouseEnter={(e: React.MouseEvent<SVGElement>) => canHover() && ctl.hoverStart(id, e.currentTarget, s.content)}
								onMouseLeave={() => ctl.hoverEnd(id)}
								onClick={(e: React.MouseEvent<SVGElement>) =>
									ctl.activate(id, e.currentTarget, s.content, { touch: wantsSheet((e.nativeEvent as PointerEvent).pointerType) })
								}
							/>
						);
					})}
					<LabelList dataKey="tag" position="top" style={{ fontSize: 10.5, fill: "#1a1810", fontWeight: 600 }} />
				</Bar>
			</BarChart>
		</ResponsiveContainer>
	);
}
