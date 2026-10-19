/** Small shared pieces of the statement pages: tie badges, status icons, and the
 *  controls / alerts badges shown in the sidebar, mobile bar and Overview strip. */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Explain } from "@/components/explain/Explain";
import { useAlerts, useControls } from "@/hooks/useFinance";
import { useDashState } from "@/lib/urlState";
import type { ExplainContent } from "@/lib/explain";
import { cn } from "@/lib/utils";
import type { MisQuery } from "@/hooks/useOverview";
import type { ControlStatus } from "@/types/finance";

/** "✓ Assets = Equity + Liabilities" chip that explains itself. */
export function TieBadge({
	ok,
	content,
	children,
	tone,
}: {
	ok: boolean;
	content: ExplainContent | (() => ExplainContent);
	children: React.ReactNode;
	tone?: "green" | "amber" | "red";
}) {
	const t = tone ?? (ok ? "green" : "amber");
	return (
		<Explain content={content} underline={false}>
			<span
				className={cn(
					"badge font-semibold",
					t === "green" && "bg-green-bg text-green",
					t === "amber" && "bg-amber-bg text-amber",
					t === "red" && "bg-red-bg text-red",
				)}
			>
				{children}
			</span>
		</Explain>
	);
}

export const STATUS_STYLE: Record<ControlStatus, { icon: string; cls: string; label: string }> = {
	pass: { icon: "✓", cls: "bg-green-bg text-green", label: "Pass" },
	warn: { icon: "⚠", cls: "bg-amber-bg text-amber", label: "Warning" },
	fail: { icon: "✗", cls: "bg-red-bg text-red", label: "Fail" },
	info: { icon: "ⓘ", cls: "bg-blue-bg text-blue", label: "Info" },
};

export function StatusIcon({ status }: { status: ControlStatus }) {
	const s = STATUS_STYLE[status];
	return (
		<span
			className={cn("inline-flex items-center justify-center w-6 h-6 rounded-full text-[12px] font-bold shrink-0", s.cls)}
			aria-label={s.label}
			title={s.label}
		>
			{s.icon}
		</span>
	);
}

/** True after `ms` — lets the page's own requests go first (badges are secondary). */
function useAfter(ms: number): boolean {
	const [on, setOn] = useState(false);
	useEffect(() => {
		const t = window.setTimeout(() => setOn(true), ms);
		return () => window.clearTimeout(t);
	}, [ms]);
	return on;
}

/** Controls summary + alert counts for the current period / company, fetched lazily
 *  (server-cached; SWR shares the request with the Controls / Alerts pages). */
export function useStatementBadges(refreshKey: number, enabled = true) {
	const { period, company, taxMode } = useDashState();
	const later = useAfter(1200);
	const q: MisQuery = { period, company, taxMode, refreshKey };
	const controls = useControls(q, enabled && later).data?.message;
	const alerts = useAlerts(q, enabled && later).data?.message;
	return { summary: controls?.summary, counts: alerts?.counts };
}

export function controlsText(s: Record<ControlStatus, number>): string {
	const parts = [`✓ ${s.pass} ties`];
	if (s.warn) parts.push(`⚠ ${s.warn}`);
	if (s.fail) parts.push(`✗ ${s.fail}`);
	return parts.join(" · ");
}

/** "✓ 17 ties · ⚠ 2" → /mis/controls. */
export function ControlsBadge({
	summary,
	variant = "light",
	className,
}: {
	summary?: Record<ControlStatus, number>;
	variant?: "light" | "dark";
	className?: string;
}) {
	const { drillTo } = useDashState();
	if (!summary) return null;
	const bad = summary.fail > 0 ? "red" : summary.warn > 0 ? "amber" : "green";
	return (
		<Link
			to={drillTo("/mis/controls")}
			className={cn(
				"inline-flex items-center gap-1 min-h-[26px] px-2.5 rounded-full text-[11px] font-semibold whitespace-nowrap tabular-nums",
				variant === "light"
					? bad === "red"
						? "bg-red-bg text-red"
						: bad === "amber"
							? "bg-amber-bg text-amber"
							: "bg-green-bg text-green"
					: "border",
				className,
			)}
			style={variant === "dark" ? { borderColor: "var(--sidebar-divider)", color: "var(--sidebar-text)" } : undefined}
			title={`Controls: ${summary.pass} pass · ${summary.warn} warning · ${summary.fail} fail · ${summary.info} info`}
			aria-label={`Controls: ${summary.pass} pass, ${summary.warn} warnings, ${summary.fail} failures — open controls`}
		>
			{controlsText(summary)}
		</Link>
	);
}

/** "3 high-severity alerts" → /mis/alerts. */
export function AlertsBadge({ counts, className }: { counts?: { high: number; medium: number; low: number }; className?: string }) {
	const { drillTo } = useDashState();
	if (!counts) return null;
	const total = counts.high + counts.medium + counts.low;
	return (
		<Link
			to={drillTo("/mis/alerts")}
			className={cn(
				"inline-flex items-center gap-1 min-h-[26px] px-2.5 rounded-full text-[11px] font-semibold whitespace-nowrap tabular-nums",
				counts.high ? "bg-red-bg text-red" : total ? "bg-amber-bg text-amber" : "bg-green-bg text-green",
				className,
			)}
			aria-label={`Alerts: ${counts.high} high, ${counts.medium} medium, ${counts.low} low — open alerts`}
		>
			{counts.high ? `● ${counts.high} high` : total ? `${total} alerts` : "No alerts"}
			{counts.high > 0 && total > counts.high && <span className="font-medium opacity-80">· {total - counts.high} more</span>}
		</Link>
	);
}

const STRIP_LINKS: Array<{ path: string; label: string }> = [
	{ path: "/mis/statement", label: "P&L statement" },
	{ path: "/mis/balance-sheet", label: "Balance sheet" },
	{ path: "/mis/cash-flow", label: "Cash flow" },
	{ path: "/mis/ratios", label: "Ratios" },
];

/** Slim Overview strip: controls + alerts badges and links to the statements. */
export function StatementsStrip({ refreshKey }: { refreshKey: number }) {
	const { drillTo } = useDashState();
	const { summary, counts } = useStatementBadges(refreshKey);
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-5 px-3.5 py-2 rounded-[12px] border border-border bg-surface/60 text-[11.5px]">
			<span className="text-[9.5px] font-semibold tracking-[0.14em] uppercase text-text-3">Statements</span>
			{summary ? <ControlsBadge summary={summary} /> : <span className="h-[26px] w-24 rounded-full bg-surface-2 animate-pulse" aria-hidden="true" />}
			{counts && <AlertsBadge counts={counts} />}
			<span className="hidden sm:block w-px h-4 bg-border" aria-hidden="true" />
			<nav aria-label="Statements" className="flex flex-wrap gap-x-3 gap-y-1">
				{STRIP_LINKS.map((l) => (
					<Link key={l.path} to={drillTo(l.path)} className="font-semibold text-green hover:underline underline-offset-2 min-h-[24px] inline-flex items-center">
						{l.label} →
					</Link>
				))}
			</nav>
		</div>
	);
}
