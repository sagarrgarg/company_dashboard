/** /mis/controls — the proof page: every tie the dashboard relies on (P&L = GL, balance
 *  sheet balances, cash flow ties, sub-ledgers = control accounts, ERPNext reports), with
 *  expected vs actual vs difference, the detail and desk links. */
import { useEffect } from "react";
import { DrillHeader, DrillSkeleton, DrillTh, ExtLink, SegTabs } from "@/components/drill/DrillLayout";
import { Explain } from "@/components/explain/Explain";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { STATUS_STYLE, StatusIcon } from "@/components/statements/StatementBits";
import { useControls } from "@/hooks/useFinance";
import { explainBridge, explainControl } from "@/lib/statements";
import { useUrlParam } from "@/lib/urlState";
import { cn, formatINR } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { ControlCheck, ControlsResponse, ControlStatus } from "@/types/finance";

type Filter = "all" | ControlStatus;
const SHORT: Record<ControlStatus, string> = { pass: "pass", warn: "warn", fail: "fail", info: "info" };
const FILTERS: readonly Filter[] = ["all", "fail", "warn", "info", "pass"] as const;

export function ControlsPage({ query, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const { data, error, isLoading } = useControls(query);
	const res = data?.message;
	const [filter, setFilter] = useUrlParam<Filter>("status", "all", FILTERS);

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const header = (
		<>
			<PreparedReportHeader refreshedAt={res?.refreshed_at} stale={res?.stale} section="mis" onRefreshed={onRefreshed} />
			<DrillHeader
				eyebrow="Statements · Controls · amounts in ₹ (lakh / crore)"
				title="Controls"
				subtitle={res ? `${res.period.label} · ${res.company} · every tie behind the dashboard, proved against the ledger and ERPNext` : undefined}
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
				<ErrorCard title="Unable to load controls" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}
	return (
		<>
			{header}
			<ControlsBody res={res} filter={filter} setFilter={setFilter} />
		</>
	);
}

function ControlsBody({ res, filter, setFilter }: { res: ControlsResponse; filter: Filter; setFilter: (f: Filter) => void }) {
	const s = res.summary;
	const shown = res.checks.filter((c) => filter === "all" || c.status === filter);
	const groups: Array<[string, ControlCheck[]]> = [];
	for (const c of shown) {
		const g = groups.find(([name]) => name === c.group);
		if (g) g[1].push(c);
		else groups.push([c.group, [c]]);
	}
	return (
		<>
			<div className="flex flex-wrap items-center gap-2 mb-4">
				{(["pass", "warn", "fail", "info"] as ControlStatus[]).map((k) => (
					<span key={k} className={cn("badge font-semibold text-[12px] !px-3 !py-1", STATUS_STYLE[k].cls)}>
						{STATUS_STYLE[k].icon} {s[k]} {SHORT[k]}
					</span>
				))}
				<span className="flex-1" />
				<SegTabs
					label="Filter checks"
					value={filter}
					onChange={setFilter}
					options={FILTERS.map((f) => ({
						key: f,
						label: f === "all" ? `All ${res.checks.length}` : `${STATUS_STYLE[f].icon} ${STATUS_STYLE[f].label}`,
						disabled: f !== "all" && s[f] === 0,
					}))}
				/>
			</div>

			{groups.length === 0 && <div className="card text-[13px] text-text-2">No checks with this status.</div>}

			<div className="space-y-4">
				{groups.map(([group, checks]) => (
					<div key={group} className="card !p-0 overflow-hidden">
						<div className="px-4 md:px-5 pt-4 pb-3 border-b border-border flex items-baseline justify-between gap-3">
							<div className="card-title !mb-0">{group}</div>
							<div className="text-[10.5px] text-text-3 font-medium">
								{checks.filter((c) => c.status === "pass").length} / {checks.length} pass
							</div>
						</div>
						<div className="px-4 md:px-0">
							<table className="drill-table w-full text-[12.5px] tabular-nums md:table-fixed">
								<colgroup>
									<col />
									<col className="md:w-[124px]" />
									<col className="md:w-[124px]" />
									<col className="md:w-[136px]" />
								</colgroup>
								<thead>
									<tr>
										<DrillTh align="left">Check</DrillTh>
										<DrillTh>Expected</DrillTh>
										<DrillTh>Actual</DrillTh>
										<DrillTh>Difference</DrillTh>
									</tr>
								</thead>
								<tbody>
									{checks.map((c) => (
										<CheckRow key={c.key} c={c} periodLabel={res.period.label} />
									))}
								</tbody>
							</table>
						</div>
					</div>
				))}
			</div>
			<div className="mt-3 text-[10.5px] text-text-3 leading-[1.7]">
				Pass = ties within ₹1 (or the check's own tolerance). Warning = a real gap to fix. Info = a known reconciling difference, explained in the
				detail (e.g. what ERPNext's own report leaves out). Links open ERPNext in a new tab.
			</div>
		</>
	);
}

function CheckRow({ c, periodLabel }: { c: ControlCheck; periodLabel: string }) {
	const num = (focus: "expected" | "actual" | "difference") => {
		const v = focus === "expected" ? c.expected : focus === "actual" ? c.actual : c.difference;
		return (
			<Explain content={() => explainControl(c, periodLabel, focus)} label={`${c.label}, ${focus} ${formatINR(v)}, has breakdown`}>
				{formatINR(v)}
			</Explain>
		);
	};
	const diffBad = c.status === "warn" || c.status === "fail";
	return (
		<tr className="border-b border-border align-top">
			<td className="drill-primary md:pl-5 md:pr-3 py-3">
				<div className="flex items-start gap-2.5 min-w-0">
					<StatusIcon status={c.status} />
					<div className="min-w-0 font-normal">
						<div className="font-semibold text-text text-[13px] leading-snug">{c.label}</div>
						{c.detail && <div className="text-[11.5px] text-text-2 mt-0.5 leading-snug max-w-[640px]">{c.detail}</div>}
						{c.links.length > 0 && (
							<div className="flex flex-wrap gap-1.5 mt-1.5">
								{c.links.map((l) => (
									<ExtLink key={l.url + l.label} href={l.url} className="!min-h-[28px]">
										{l.label}
									</ExtLink>
								))}
							</div>
						)}
						{c.bridge && c.bridge.length > 0 && <Bridge c={c} periodLabel={periodLabel} />}
					</div>
				</div>
			</td>
			<td data-label="Expected" className="md:px-3 py-3 text-right whitespace-nowrap text-text-2">{num("expected")}</td>
			<td data-label="Actual" className="md:px-3 py-3 text-right whitespace-nowrap">{num("actual")}</td>
			<td
				data-label="Difference"
				className={cn("md:pl-3 md:pr-5 py-3 text-right whitespace-nowrap font-semibold", diffBad ? "text-amber" : c.status === "pass" ? "text-green" : "text-blue")}
			>
				{num("difference")}
			</td>
		</tr>
	);
}

function Bridge({ c, periodLabel }: { c: ControlCheck; periodLabel: string }) {
	const b = c.bridge ?? [];
	return (
		<div className="mt-2.5 rounded-lg border border-border bg-surface-2/40 overflow-hidden max-w-[640px]">
			<div className="px-3 pt-2 pb-1 text-[9.5px] font-semibold tracking-[0.1em] uppercase text-text-3">Bridge</div>
			<table className="w-full text-[11.5px] tabular-nums">
				<tbody>
					{b.map((x, i) => (
						<tr key={i} className={cn("border-t border-border", x.kind !== "adjust" && "font-semibold bg-surface/60")}>
							<td className="px-3 py-1.5 text-text-3 w-4 align-top">{x.kind === "start" ? "" : x.kind === "end" ? "=" : x.amount < 0 ? "−" : "+"}</td>
							<td className="py-1.5 pr-2 text-text leading-snug align-top break-words">{x.label}</td>
							<td className={cn("px-3 py-1.5 text-right whitespace-nowrap align-top", x.kind === "adjust" && x.amount < 0 && "text-red")}>
								<Explain content={() => explainBridge(c, periodLabel)} underline={x.kind === "end"} label={`${x.label}, ${formatINR(x.amount)}, has breakdown`}>
									{formatINR(x.kind === "adjust" ? Math.abs(x.amount) : x.amount)}
								</Explain>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
