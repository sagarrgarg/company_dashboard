/** /mis/alerts — exceptions that make figures unreliable or need action (negative stock,
 *  failed reposts, impossible cost, old receivables, manual JEs, back-dated entries…),
 *  by severity, each with count, ₹ impact, detail, the documents behind it and desk links. */
import { useEffect, useState } from "react";
import { DrillHeader, DrillSkeleton, ExtLink } from "@/components/drill/DrillLayout";
import { Explain } from "@/components/explain/Explain";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { useAlerts } from "@/hooks/useFinance";
import { explainAlert } from "@/lib/statements";
import { cn, formatINR, formatNumber } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { Alert, AlertSeverity, AlertsResponse } from "@/types/finance";

const SEV: Record<AlertSeverity, { title: string; dot: string; chip: string; bar: string }> = {
	high: { title: "High", dot: "bg-red", chip: "bg-red-bg text-red", bar: "var(--red)" },
	medium: { title: "Medium", dot: "bg-amber", chip: "bg-amber-bg text-amber", bar: "var(--amber)" },
	low: { title: "Low", dot: "bg-blue", chip: "bg-blue-bg text-blue", bar: "var(--blue)" },
};

export function AlertsPage({ query, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const { data, error, isLoading } = useAlerts(query);
	const res = data?.message;

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const header = (
		<>
			<PreparedReportHeader refreshedAt={res?.refreshed_at} stale={res?.stale} section="mis" onRefreshed={onRefreshed} />
			<DrillHeader
				eyebrow="Statements · Alerts · amounts in ₹ (lakh / crore)"
				title="Alerts"
				subtitle={res ? `${res.period.label} · ${res.company} · what to fix before trusting the numbers` : undefined}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
				right={
					res && (
						<div className="flex flex-wrap gap-1.5 md:justify-end">
							{(["high", "medium", "low"] as AlertSeverity[]).map((k) => (
								<a key={k} href={`#sev-${k}`} className={cn("badge font-semibold", SEV[k].chip)}>
									{res.counts[k]} {SEV[k].title.toLowerCase()}
								</a>
							))}
						</div>
					)
				}
			/>
		</>
	);

	if (isLoading && !res) return (<>{header}<DrillSkeleton /></>);
	if (error || !res) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load alerts" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}
	return (
		<>
			{header}
			<AlertsBody res={res} />
		</>
	);
}

function AlertsBody({ res }: { res: AlertsResponse }) {
	if (!res.alerts.length) return <div className="card text-[13px] text-text-2">✓ No alerts for this period.</div>;
	return (
		<div className="space-y-6">
			{(["high", "medium", "low"] as AlertSeverity[]).map((sev) => {
				const list = res.alerts.filter((a) => a.severity === sev);
				if (!list.length) return null;
				return (
					<section key={sev} id={`sev-${sev}`} className="scroll-mt-16">
						<div className="flex items-center gap-2.5 mb-3">
							<span className={cn("w-2.5 h-2.5 rounded-full", SEV[sev].dot)} />
							<span className="font-semibold text-[15px] tracking-tight" style={{ color: SEV[sev].bar }}>
								{SEV[sev].title} severity
							</span>
							<span className="flex-1 h-px bg-border" />
							<span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">{list.length} alerts</span>
						</div>
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
							{list.map((a) => (
								<AlertCard key={a.key} a={a} periodLabel={res.period.label} />
							))}
						</div>
					</section>
				);
			})}
		</div>
	);
}

function AlertCard({ a, periodLabel }: { a: Alert; periodLabel: string }) {
	const [open, setOpen] = useState(false);
	const s = SEV[a.severity];
	return (
		<div className="card !p-0 overflow-hidden" style={{ boxShadow: `inset 3px 0 0 ${s.bar}` }}>
			<div className="px-4 md:px-5 pt-4 pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="font-semibold text-[13.5px] text-text leading-snug">{a.label}</div>
					<span className={cn("badge font-semibold shrink-0 uppercase !text-[9.5px] tracking-[0.08em]", s.chip)}>{a.severity}</span>
				</div>
				<div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 mt-2">
					{a.count != null && (
						<div>
							<div className="text-[9.5px] font-semibold tracking-[0.1em] uppercase text-text-3">Count</div>
							<div className="text-[20px] font-semibold tabular-nums tracking-tight">
								<Explain content={() => explainAlert(a, periodLabel, "count")} label={`${a.label}, ${a.count} items, has breakdown`}>
									{formatNumber(a.count)}
								</Explain>
							</div>
						</div>
					)}
					{a.amount != null && (
						<div>
							<div className="text-[9.5px] font-semibold tracking-[0.1em] uppercase text-text-3">₹ impact</div>
							<div className={cn("text-[20px] font-semibold tabular-nums tracking-tight", a.amount < 0 && "text-red")}>
								<Explain content={() => explainAlert(a, periodLabel, "amount")} label={`${a.label}, ${formatINR(a.amount)}, has breakdown`}>
									{formatINR(a.amount)}
								</Explain>
							</div>
						</div>
					)}
				</div>
				{a.detail && <p className="text-[11.5px] text-text-2 mt-2 leading-snug">{a.detail}</p>}
				<div className="flex flex-wrap gap-1.5 mt-2.5">
					{a.rows.length > 0 && (
						<button
							type="button"
							onClick={() => setOpen((o) => !o)}
							aria-expanded={open}
							className="inline-flex items-center gap-1 min-h-[32px] px-3 rounded-full bg-green text-white text-[11.5px] font-semibold hover:bg-green-mid"
						>
							{open ? "Hide" : "Show"} {a.rows.length}
							{a.count != null && a.count > a.rows.length && !a.rows.some((r) => r.count != null) ? ` of ${formatNumber(a.count)}` : ""}{" "}
							{a.rows.some((r) => r.count != null) ? (a.rows.length === 1 ? "group" : "groups") : a.rows.length === 1 ? "item" : "items"}
							<span aria-hidden="true" className={cn("transition-transform", open && "rotate-180")}>▾</span>
						</button>
					)}
					{a.links.map((l) => (
						<ExtLink key={l.url + l.label} href={l.url}>
							{l.label}
						</ExtLink>
					))}
				</div>
			</div>
			{open && (
				<ul className="border-t border-border divide-y divide-border text-[12px] tabular-nums">
					{a.rows.map((r, i) => (
						<li key={r.url + i} className="px-4 md:px-5 py-2 flex items-start justify-between gap-3">
							<div className="min-w-0">
								<a href={r.url} target="_blank" rel="noopener" className="text-green hover:underline underline-offset-2 break-words">
									{r.label} <span aria-hidden="true">↗</span>
									<span className="sr-only">(opens in a new tab)</span>
								</a>
								{(r.qty != null || r.age != null) && (
									<div className="text-[10.5px] text-text-3">
										{[r.qty != null ? `qty ${formatNumber(r.qty, 2)}` : "", r.age != null ? `${r.age} days old` : ""].filter(Boolean).join(" · ")}
									</div>
								)}
							</div>
							<div className={cn("shrink-0 text-right font-semibold", (r.amount ?? 0) < 0 && "text-red")}>
								{r.amount != null ? formatINR(r.amount) : r.count != null ? `${formatNumber(r.count)}` : ""}
							</div>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
