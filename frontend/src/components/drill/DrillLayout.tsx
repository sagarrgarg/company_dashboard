/** Shared pieces of every drill page (P&L line, account, invoices — and the later
 *  balance-sheet / cash-flow / ratio drills): breadcrumbs that carry the URL state, a
 *  header with the period control, stat tiles, a monthly bar chart, desk links and a
 *  pager. Tables use `.drill-table` so they collapse to cards on phones. */
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { cn, formatINR, formatNumber } from "@/lib/utils";
import { useDashState, type ExtraParams } from "@/lib/urlState";
import type { PeriodSelection } from "@/types/mis";

export interface Crumb {
	label: string;
	/** In-app path; omitted for the current page. */
	path?: string;
	extra?: ExtraParams;
}

/** "Overview › CM2 › Outbound freight › Freight and Forwarding Charges - GGSPL". Every
 *  crumb is a same-tab link (history push), so Back walks back up. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
	const { drillTo } = useDashState();
	return (
		<nav aria-label="Breadcrumb" className="mb-3">
			<ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] font-medium text-text-3">
				{items.map((c, i) => {
					const last = i === items.length - 1;
					return (
						<li key={i} className="flex items-center gap-1.5 min-w-0">
							{c.path && !last ? (
								<Link
									to={drillTo(c.path, c.extra)}
									className="text-green hover:underline underline-offset-2 truncate max-w-[260px]"
								>
									{c.label}
								</Link>
							) : (
								<span className="text-text-2 truncate max-w-[320px]" aria-current={last ? "page" : undefined}>
									{c.label}
								</span>
							)}
							{!last && (
								<span aria-hidden="true" className="text-text-4">
									›
								</span>
							)}
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

export function DrillHeader({
	eyebrow,
	title,
	subtitle,
	period,
	onPeriodChange,
	company,
	right,
}: {
	eyebrow: string;
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	/** Omit (with onPeriodChange) on pages that don't take a period (balance sheet as-of). */
	period?: PeriodSelection;
	onPeriodChange?: (p: PeriodSelection) => void;
	company: string;
	right?: React.ReactNode;
}) {
	return (
		<header className="flex flex-col md:flex-row md:justify-between md:items-start gap-4 mb-5">
			<div className="min-w-0">
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">{eyebrow}</div>
				<h1 className="font-serif text-[24px] md:text-[28px] leading-[1.15] text-text tracking-tight break-words">
					{title}
				</h1>
				{subtitle && <div className="text-[12px] text-text-2 mt-1.5 font-medium">{subtitle}</div>}
			</div>
			<div className="flex flex-col md:items-end gap-2.5 shrink-0">
				{period && onPeriodChange && <PeriodPicker value={period} onChange={onPeriodChange} company={company} />}
				{right}
			</div>
		</header>
	);
}

export function StatTile({
	label,
	value,
	sub,
	tone = "default",
	children,
}: {
	label: string;
	value?: React.ReactNode;
	sub?: React.ReactNode;
	tone?: "default" | "green" | "red" | "amber" | "blue";
	children?: React.ReactNode;
}) {
	const toneCls = {
		default: "text-text",
		green: "text-green",
		red: "text-red",
		amber: "text-amber",
		blue: "text-blue",
	}[tone];
	return (
		<div className="kpi min-w-0">
			<div className="kpi-lbl">{label}</div>
			{value !== undefined && <div className={cn("kpi-val text-[20px] md:text-[22px] break-words", toneCls)}>{value}</div>}
			{children}
			{sub && <div className="kpi-meta flex-wrap">{sub}</div>}
		</div>
	);
}

/** A real new-tab link ("Open in ERPNext ↗"). */
export function ExtLink({
	href,
	children,
	className,
	variant = "pill",
}: {
	href: string;
	children: React.ReactNode;
	className?: string;
	variant?: "pill" | "primary" | "inline";
}) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener"
			className={cn(
				variant === "pill" &&
					"inline-flex items-center gap-1 min-h-[32px] px-3 rounded-full border border-border-md bg-surface text-[11.5px] font-semibold text-text-2 hover:bg-surface-2 hover:text-text",
				variant === "primary" &&
					"inline-flex items-center gap-1 min-h-[32px] px-3 rounded-full bg-green text-white text-[11.5px] font-semibold hover:bg-green-mid",
				variant === "inline" && "text-green hover:underline underline-offset-2",
				className,
			)}
		>
			{children}
			<span aria-hidden="true">↗</span>
			<span className="sr-only">(opens in a new tab)</span>
		</a>
	);
}

export interface MonthBar {
	key: string;
	label: string;
	value: number;
	partial?: boolean;
}

/** Monthly bars; a partial month (month-to-date) is drawn dashed and lighter. */
export function MonthlyBars({
	data,
	height = 200,
	color = "#1F5F33",
	negativeColor = "#7A1F1F",
	valueLabel = "Amount",
}: {
	data: MonthBar[];
	height?: number;
	color?: string;
	negativeColor?: string;
	valueLabel?: string;
}) {
	if (!data.length) return <div className="h-[120px] flex items-center justify-center text-[12px] text-text-3">No months in this period.</div>;
	return (
		<ResponsiveContainer width="100%" height={height}>
			<BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
				<CartesianGrid stroke="rgba(40,30,15,.07)" vertical={false} />
				<XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "#7A6F5D" }} interval="preserveStartEnd" />
				<YAxis
					tickLine={false}
					axisLine={false}
					tick={{ fontSize: 10, fill: "#7A6F5D" }}
					tickFormatter={(v) => formatINR(Number(v))}
					width={64}
				/>
				<Tooltip
					cursor={{ fill: "rgba(40,30,15,.04)" }}
					formatter={(v: number, _n, item) => [
						`${formatINR(v)}${(item?.payload as MonthBar | undefined)?.partial ? " (month to date)" : ""}`,
						valueLabel,
					]}
					contentStyle={{ borderRadius: 10, border: "1px solid rgba(40,30,15,.18)", fontSize: 12 }}
				/>
				<Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
					{data.map((d) => {
						const c = d.value < 0 ? negativeColor : color;
						return (
							<Cell
								key={d.key}
								fill={c}
								fillOpacity={d.partial ? 0.28 : 0.9}
								stroke={d.partial ? c : undefined}
								strokeDasharray={d.partial ? "4 3" : undefined}
								strokeWidth={d.partial ? 1.5 : 0}
							/>
						);
					})}
				</Bar>
			</BarChart>
		</ResponsiveContainer>
	);
}

/** Prev / next pager for server-paginated tables. */
export function Pager({
	start,
	pageLength,
	total,
	onChange,
	noun = "rows",
}: {
	start: number;
	pageLength: number;
	total: number;
	onChange: (start: number) => void;
	noun?: string;
}) {
	if (total <= pageLength && start === 0) {
		return <div className="text-[11px] text-text-3 mt-3">{formatNumber(total)} {noun}</div>;
	}
	const end = Math.min(start + pageLength, total);
	const btn =
		"min-h-[36px] px-3.5 rounded-full border border-border-md bg-surface text-[11.5px] font-semibold text-text-2 hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed";
	return (
		<div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
			<div className="text-[11px] text-text-3 tabular-nums">
				{formatNumber(start + 1)}–{formatNumber(end)} of {formatNumber(total)} {noun}
			</div>
			<div className="flex gap-2">
				<button type="button" className={btn} disabled={start === 0} onClick={() => onChange(Math.max(0, start - pageLength))}>
					← Previous
				</button>
				<button type="button" className={btn} disabled={end >= total} onClick={() => onChange(start + pageLength)}>
					Next →
				</button>
			</div>
		</div>
	);
}

export function DrillSkeleton() {
	return (
		<div className="animate-pulse space-y-3">
			<div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
				{[0, 1, 2, 3].map((i) => (
					<div key={i} className="h-20 bg-surface-2 rounded-[12px]" />
				))}
			</div>
			<div className="h-56 bg-surface-2 rounded-[12px]" />
			<div className="h-72 bg-surface-2 rounded-[12px]" />
		</div>
	);
}

export function DrillTh({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
	return (
		<th
			className={cn(
				"px-3 py-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 border-b border-border whitespace-nowrap",
				align === "left" ? "text-left" : "text-right",
			)}
		>
			{children}
		</th>
	);
}

/** Pill tabs bound to a URL param (bucket, sort…). */
export function SegTabs<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T;
	options: Array<{ key: T; label: string; disabled?: boolean; title?: string }>;
	onChange: (v: T) => void;
	label: string;
}) {
	return (
		<div
			className="inline-flex flex-wrap items-center gap-1 p-1 rounded-full border border-border-md bg-surface w-fit shadow-[0_1px_2px_rgba(40,30,15,.05)]"
			role="tablist"
			aria-label={label}
		>
			{options.map((o) => (
				<button
					key={o.key}
					type="button"
					role="tab"
					aria-selected={value === o.key}
					disabled={o.disabled}
					title={o.title}
					onClick={() => onChange(o.key)}
					className={cn(
						"px-3.5 min-h-[28px] text-[11px] font-semibold rounded-full transition-all tracking-wide",
						value === o.key
							? "bg-green text-white shadow-[0_1px_2px_rgba(31,95,51,.25)]"
							: "text-text-2 hover:bg-surface-2",
						o.disabled && "opacity-50 cursor-not-allowed hover:bg-transparent",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
