import { useEffect, useMemo, useState } from "react";
import {
	Area,
	AreaChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { KpiTile } from "@/components/widgets/KpiTile";
import { useCustomerSegments } from "@/hooks/useOverview";
import { cn, formatINRShort, formatPct } from "@/lib/utils";
import type { CustomerSegment, IntentFilter, PeriodSelection, TaxMode } from "@/types/mis";

interface Props {
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
	onCompanyResolved?: (company: string) => void;
}

const ALL_TAB = "__all__";

const INTENTS: Array<{ key: IntentFilter; label: string; hint: string }> = [
	{ key: "all", label: "All", hint: "All sales-intent items" },
	{ key: "b2c", label: "B2C", hint: "Items with B2C* sales intent" },
	{ key: "b2b", label: "B2B", hint: "Items with B2B* sales intent" },
];

export function CustomerSegmentsPage({
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
	onCompanyResolved,
}: Props) {
	const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
	const [intent, setIntent] = useState<IntentFilter>("all");
	const { data, error, isLoading } = useCustomerSegments(taxMode, period, intent);
	const res = data?.message;

	useEffect(() => {
		if (res?.company) onCompanyResolved?.(res.company);
	}, [res?.company, onCompanyResolved]);

	const segments = res?.segments ?? [];
	const active = activeTab === ALL_TAB ? null : segments.find((s) => s.segment === activeTab);
	const taxLabel = taxMode === "incl" ? "Tax-inclusive" : "Tax-exclusive";
	const intentLabel = intent === "all" ? "All items" : intent === "b2c" ? "B2C items only" : "B2B items only";
	const pivot = res?.pivot ?? "group";
	const rowNoun = pivot === "customer" ? "customer" : "segment";
	const scopeSuffix = pivot === "customer" && res?.scope_groups?.length
		? ` · scoped to ${res.scope_groups.slice(0, 3).join(", ")}${res.scope_groups.length > 3 ? `, +${res.scope_groups.length - 3}` : ""}`
		: "";

	return (
		<>
			<header className="flex justify-between items-start mb-6 gap-4">
				<div>
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						Customer Segment Analysis
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
						{res?.company ?? "Customers"}
					</h1>
					<div className="text-[12px] text-text-2 mt-1.5 font-medium">
						{res
							? `${res.period.label} · ${taxLabel} · ${intentLabel} · ${res.totals.segment_count} ${rowNoun}${res.totals.segment_count === 1 ? "" : "s"}${scopeSuffix}`
							: "loading…"}
					</div>
				</div>
				<div className="flex items-center gap-2 flex-wrap justify-end">
					<IntentTabs value={intent} onChange={setIntent} />
					<PeriodPicker value={period} onChange={onPeriodChange} />
					<TaxModeTabs value={taxMode} onChange={onTaxModeChange} />
				</div>
			</header>

			{isLoading && <div className="card animate-pulse h-96" />}
			{error && (
				<div className="card">
					<div className="card-title text-red">Unable to load segments</div>
					<p className="text-[12px] text-text-2">{error.message}</p>
				</div>
			)}

			{res && (
				<>
					<SegmentTabBar
						segments={segments}
						totalRevenue={res.totals.revenue}
						active={activeTab}
						onChange={setActiveTab}
						pivot={pivot}
					/>

					{activeTab === ALL_TAB ? (
						<AllSegmentsView res={res} onSelect={setActiveTab} pivot={pivot} />
					) : active ? (
						<SegmentDetail
							segment={active}
							totalRevenue={res.totals.revenue}
							monthKeys={res.month_keys}
							pivot={pivot}
						/>
					) : (
						<div className="card">
							<div className="card-title">{pivot === "customer" ? "Customer" : "Segment"} not found</div>
							<p className="text-[12px] text-text-2">
								The selected {rowNoun} isn't in the current period — pick another tab.
							</p>
						</div>
					)}
				</>
			)}
		</>
	);
}

function SegmentTabBar({
	segments,
	totalRevenue,
	active,
	onChange,
	pivot,
}: {
	segments: CustomerSegment[];
	totalRevenue: number;
	active: string;
	onChange: (next: string) => void;
	pivot: "group" | "customer";
}) {
	const allLabel = pivot === "customer" ? "All customers" : "All segments";
	return (
		<div className="flex flex-wrap items-center gap-1.5 mb-5 pb-3 border-b border-border">
			<TabButton
				active={active === ALL_TAB}
				onClick={() => onChange(ALL_TAB)}
				label={
					<>
						{allLabel} <span className="text-[9.5px] font-medium opacity-80 ml-0.5">{segments.length}</span>
					</>
				}
			/>
			{segments.map((s) => {
				const share = totalRevenue ? (s.revenue / totalRevenue) * 100 : 0;
				return (
					<TabButton
						key={s.segment}
						active={active === s.segment}
						onClick={() => onChange(s.segment)}
						label={
							<span className="flex items-center gap-1.5">
								<span className="truncate max-w-[120px]" title={s.segment}>
									{s.segment}
								</span>
								<span className="text-[9.5px] font-medium opacity-80">{formatPct(share, 0)}</span>
							</span>
						}
					/>
				);
			})}
		</div>
	);
}

function TabButton({
	active,
	onClick,
	label,
}: {
	active: boolean;
	onClick: () => void;
	label: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"px-3 py-[5px] text-[11.5px] font-semibold rounded-full transition-all tracking-wide border",
				active
					? "bg-green text-white border-green shadow-[0_1px_2px_rgba(31,95,51,.25)]"
					: "bg-surface text-text-2 border-border-md hover:bg-surface-2 hover:text-text",
			)}
		>
			{label}
		</button>
	);
}

function AllSegmentsView({
	res,
	onSelect,
	pivot,
}: {
	res: { segments: CustomerSegment[]; totals: { revenue: number; customers: number; invoices: number; aov: number; gm_pct: number; gp: number } };
	onSelect: (segment: string) => void;
	pivot: "group" | "customer";
}) {
	const { segments, totals } = res;
	const firstColLabel = pivot === "customer" ? "Customer" : "Segment";
	return (
		<>
			<div className="grid grid-cols-5 gap-2.5 mb-4">
				<KpiTile label="Total Revenue" value={formatINRShort(totals.revenue)} meta={`${totals.invoices.toLocaleString("en-IN")} invoices`} />
				<KpiTile label="Customers" value={totals.customers.toLocaleString("en-IN")} accent="blue" meta="distinct" />
				<KpiTile label="Avg Order Value" value={formatINRShort(totals.aov)} meta="across all segments" />
				<KpiTile label="Gross Profit" value={formatINRShort(totals.gp)} accent={totals.gp > 0 ? "green" : "red"} meta="valuated lines only" />
				<KpiTile label="GM %" value={formatPct(totals.gm_pct)} accent={totals.gm_pct > 0 ? "green" : "red"} meta="company-wide" />
			</div>

			<div className="card !p-0 overflow-hidden">
				<div className="overflow-x-auto">
					<table className="w-full text-[12px] tabular-nums">
						<thead>
							<tr>
								<Th align="left">{firstColLabel}</Th>
								{pivot === "group" && <Th>Customers</Th>}
								<Th>Invoices</Th>
								<Th>Revenue</Th>
								<Th>% Mix</Th>
								<Th>YoY</Th>
								<Th>AOV</Th>
								<Th>GM %</Th>
							</tr>
						</thead>
						<tbody>
							{segments.map((s) => {
								const share = totals.revenue ? (s.revenue / totals.revenue) * 100 : 0;
								const isUnassigned = s.segment === "(unassigned)";
								return (
									<tr
										key={s.segment}
										className={cn(
											"border-b border-border last:border-b-0 hover:bg-surface-2/60 cursor-pointer transition-colors",
											isUnassigned && "bg-amber-bg/30",
										)}
										onClick={() => onSelect(s.segment)}
									>
										<td className="px-3 py-2 text-left">
											<span className={cn("font-semibold", isUnassigned ? "text-amber" : "text-text")}>
												{s.segment}
											</span>
										</td>
										{pivot === "group" && (
											<td className="px-3 py-2 text-right text-text-2">
												{s.customers.toLocaleString("en-IN")}
											</td>
										)}
										<td className="px-3 py-2 text-right text-text-2">
											{s.invoices.toLocaleString("en-IN")}
										</td>
										<td className="px-3 py-2 text-right font-semibold text-text">
											{formatINRShort(s.revenue)}
										</td>
										<td className={cn("px-3 py-2 text-right", share > 10 ? "font-semibold text-text" : "text-text-3")}>
											{formatPct(share)}
										</td>
										<td className={cn("px-3 py-2 text-right tabular-nums", yoyColor(s.yoy_pct))}>
											{s.yoy_pct == null ? "—" : `${s.yoy_pct > 0 ? "↑" : "↓"}${Math.abs(s.yoy_pct).toFixed(0)}%`}
										</td>
										<td className="px-3 py-2 text-right text-text-2">{formatINRShort(s.aov)}</td>
										<td className={cn("px-3 py-2 text-right", marginColor(s.gm_pct))}>
											{formatPct(s.gm_pct)}
										</td>
									</tr>
								);
							})}
							<tr className="bg-surface-2 font-semibold border-t-2 border-border-md">
								<td className="px-3 py-2.5 text-left text-text">Total</td>
								{pivot === "group" && (
									<td className="px-3 py-2.5 text-right">{totals.customers.toLocaleString("en-IN")}</td>
								)}
								<td className="px-3 py-2.5 text-right">{totals.invoices.toLocaleString("en-IN")}</td>
								<td className="px-3 py-2.5 text-right text-text">{formatINRShort(totals.revenue)}</td>
								<td className="px-3 py-2.5 text-right">100%</td>
								<td className="px-3 py-2.5 text-right text-text-3">—</td>
								<td className="px-3 py-2.5 text-right">{formatINRShort(totals.aov)}</td>
								<td className={cn("px-3 py-2.5 text-right", marginColor(totals.gm_pct))}>
									{formatPct(totals.gm_pct)}
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>

			{pivot === "group" && segments.some((s) => s.segment === "(unassigned)") && (
				<div className="mt-4 px-4 py-3 rounded-lg bg-amber-bg border border-amber/20 text-amber text-[12px] leading-relaxed flex items-start gap-2.5">
					<span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-amber text-white text-[10px] font-bold flex items-center justify-center">
						!
					</span>
					<div>
						<strong className="font-semibold">Heads up:</strong> the{" "}
						<span className="font-mono text-[11px] px-1 py-0.5 rounded bg-amber/10">(unassigned)</span> bucket
						is customers without a Customer Group set. Tag them in ERPNext's Customer master so they roll up
						into the right channel — Modern Trade, GT Distribution, etc.
					</div>
				</div>
			)}
		</>
	);
}

function SegmentDetail({
	segment,
	totalRevenue,
	monthKeys,
	pivot,
}: {
	segment: CustomerSegment;
	totalRevenue: number;
	monthKeys: string[];
	pivot: "group" | "customer";
}) {
	const share = totalRevenue ? (segment.revenue / totalRevenue) * 100 : 0;
	const trendData = useMemo(
		() =>
			monthKeys.map((mk) => ({
				month: shortMonth(mk),
				revenue: segment.monthly[mk] ?? 0,
			})),
		[monthKeys, segment.monthly],
	);
	const concentration = useMemo(() => {
		if (!segment.top_customers.length || !segment.revenue) return 0;
		const top3 = segment.top_customers.slice(0, 3).reduce((s, c) => s + c.revenue, 0);
		return (top3 / segment.revenue) * 100;
	}, [segment]);

	const isCustomer = pivot === "customer";

	return (
		<>
			<div className="grid grid-cols-5 gap-2.5 mb-4">
				<KpiTile
					label="Revenue"
					value={formatINRShort(segment.revenue)}
					meta={`${formatPct(share)} of ${isCustomer ? "scope" : "total"}`}
				/>
				{isCustomer ? (
					<KpiTile
						label="Invoices"
						value={segment.invoices.toLocaleString("en-IN")}
						accent="blue"
						meta="in period"
					/>
				) : (
					<KpiTile
						label="Customers"
						value={segment.customers.toLocaleString("en-IN")}
						accent="blue"
						meta={`${segment.invoices.toLocaleString("en-IN")} invoices`}
					/>
				)}
				<KpiTile
					label="AOV"
					value={formatINRShort(segment.aov)}
					meta="per invoice"
				/>
				{isCustomer ? (
					<KpiTile
						label="Gross Profit"
						value={formatINRShort(segment.gp)}
						accent={segment.gp > 0 ? "green" : "red"}
						meta="tax-excl, valuated lines"
					/>
				) : (
					<KpiTile
						label="Avg Customer Value"
						value={formatINRShort(segment.avg_customer_value)}
						meta="rev / customer"
					/>
				)}
				<KpiTile
					label="GM %"
					value={formatPct(segment.gm_pct)}
					accent={segment.gm_pct > 5 ? "green" : segment.gm_pct > 0 ? "amber" : "red"}
					meta={`${Math.round(segment.gm_coverage_pct)}% valuated`}
				/>
			</div>

			<div className={cn("grid gap-4 mb-4", isCustomer ? "grid-cols-1" : "grid-cols-[1.6fr_1fr]")}>
				<div className="card">
					<div className="flex items-center justify-between mb-3">
						<div>
							<div className="card-title mb-0.5">Monthly revenue</div>
							<div className="text-[11px] text-text-3 font-medium">₹L · {segment.segment}</div>
						</div>
						{segment.yoy_pct != null && (
							<div className={cn("text-[12px] font-semibold tabular-nums", yoyColor(segment.yoy_pct))}>
								{segment.yoy_pct > 0 ? "↑" : "↓"}{Math.abs(segment.yoy_pct).toFixed(1)}% vs prior period
							</div>
						)}
					</div>
					<ResponsiveContainer width="100%" height={220}>
						<AreaChart data={trendData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
							<defs>
								<linearGradient id={`fillSeg-${segment.segment}`} x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stopColor="#1F5F33" stopOpacity={0.28} />
									<stop offset="100%" stopColor="#1F5F33" stopOpacity={0} />
								</linearGradient>
							</defs>
							<CartesianGrid stroke="rgba(40,30,15,.07)" vertical={false} />
							<XAxis
								dataKey="month"
								tickLine={false}
								axisLine={false}
								tick={{ fontSize: 10, fill: "#7A6F5D", fontWeight: 500 }}
							/>
							<YAxis
								tickLine={false}
								axisLine={false}
								tick={{ fontSize: 10, fill: "#7A6F5D", fontWeight: 500 }}
								tickFormatter={(v) => `₹${v}L`}
								width={48}
							/>
							<Tooltip
								cursor={{ stroke: "rgba(40,30,15,.18)" }}
								contentStyle={{
									background: "#fff",
									border: "1px solid rgba(40,30,15,.18)",
									borderRadius: 10,
									fontSize: 12,
									padding: "8px 12px",
									boxShadow: "0 4px 16px rgba(40,30,15,.08)",
								}}
								formatter={(v: number) => [`₹${v.toFixed(1)}L`, "Revenue"]}
							/>
							<Area
								type="monotone"
								dataKey="revenue"
								stroke="#1F5F33"
								strokeWidth={2.25}
								fill={`url(#fillSeg-${segment.segment})`}
							/>
						</AreaChart>
					</ResponsiveContainer>
				</div>

				{!isCustomer && (
				<div className="card">
					<div className="card-title">Top customers</div>
					<div className="text-[10.5px] text-text-3 mb-2">
						Top 3 ={" "}
						<span className={cn("font-semibold", concentration > 60 ? "text-amber" : "text-text-2")}>
							{formatPct(concentration)}
						</span>{" "}
						of segment revenue {concentration > 60 && "(concentration risk)"}
					</div>
					<table className="w-full text-[11.5px] tabular-nums">
						<tbody>
							{segment.top_customers.map((c, i) => {
								const cshare = segment.revenue ? (c.revenue / segment.revenue) * 100 : 0;
								return (
									<tr key={c.customer} className="border-b border-border last:border-b-0">
										<td className="py-1.5 pr-2 text-text-3 w-6">{i + 1}.</td>
										<td className="py-1.5 pr-2">
											<div className="font-medium text-text truncate max-w-[180px]" title={c.customer_name}>
												{c.customer_name}
											</div>
											<div className="text-[10px] text-text-4">
												{c.invoices.toLocaleString("en-IN")} invoices
											</div>
										</td>
										<td className="py-1.5 text-right">
											<div className="font-semibold text-text">{formatINRShort(c.revenue)}</div>
											<div className="text-[10px] text-text-3">{formatPct(cshare)}</div>
										</td>
									</tr>
								);
							})}
							{segment.top_customers.length === 0 && (
								<tr>
									<td colSpan={3} className="py-4 text-center text-text-3 text-[11px]">
										No customer-level rows in period.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
				)}
			</div>

			<div className="card">
				<div className="flex items-center justify-between mb-3">
					<div className="card-title mb-0">Top categories purchased</div>
					<div className="text-[10.5px] text-text-3 font-medium">
						Top {segment.top_categories.length}
					</div>
				</div>
				<table className="w-full text-[12px] tabular-nums">
					<thead>
						<tr>
							<Th align="left">Category</Th>
							<Th>SKUs</Th>
							<Th>Revenue</Th>
							<Th>% of segment</Th>
						</tr>
					</thead>
					<tbody>
						{segment.top_categories.map((c) => {
							const cshare = segment.revenue ? (c.revenue / segment.revenue) * 100 : 0;
							return (
								<tr key={c.category} className="border-b border-border last:border-b-0">
									<td className="px-3 py-2 text-left text-text-2">{c.category}</td>
									<td className="px-3 py-2 text-right text-text-3">{c.sku_count}</td>
									<td className="px-3 py-2 text-right font-medium text-text">{formatINRShort(c.revenue)}</td>
									<td className={cn("px-3 py-2 text-right", cshare > 25 ? "font-semibold text-text" : "text-text-2")}>
										{formatPct(cshare)}
									</td>
								</tr>
							);
						})}
						{segment.top_categories.length === 0 && (
							<tr>
								<td colSpan={4} className="py-4 text-center text-text-3 text-[11px]">
									No category data in period.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
		</>
	);
}

function Th({ children, align = "right" }: { children: React.ReactNode; align?: "left" | "right" }) {
	return (
		<th
			className={cn(
				"px-3 py-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 border-b border-border bg-surface",
				align === "left" ? "text-left" : "text-right",
			)}
		>
			{children}
		</th>
	);
}

function yoyColor(yoy: number | null): string {
	if (yoy == null) return "text-text-3";
	if (yoy > 0) return "text-green";
	if (yoy < 0) return "text-red";
	return "text-text-3";
}

function marginColor(pct: number): string {
	if (pct > 5) return "text-green font-semibold";
	if (pct > 0) return "text-amber";
	return "text-red font-semibold";
}

function IntentTabs({
	value,
	onChange,
}: {
	value: IntentFilter;
	onChange: (next: IntentFilter) => void;
}) {
	return (
		<div
			className="inline-flex items-center p-1 rounded-full border border-border-md bg-surface shadow-[0_1px_2px_rgba(40,30,15,.05)]"
			role="tablist"
			aria-label="Sales intent"
		>
			{INTENTS.map((it) => {
				const active = it.key === value;
				return (
					<button
						key={it.key}
						type="button"
						role="tab"
						aria-selected={active}
						title={it.hint}
						onClick={() => onChange(it.key)}
						className={cn(
							"px-3.5 py-[5px] text-[11px] font-semibold rounded-full transition-all tracking-wide",
							active
								? "bg-green text-white shadow-[0_1px_2px_rgba(31,95,51,.25)]"
								: "text-text-2 hover:text-text hover:bg-surface-2",
						)}
					>
						{it.label}
					</button>
				);
			})}
		</div>
	);
}

function shortMonth(key: string): string {
	const [, m] = key.split("-");
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return MONTHS[Number(m) - 1] ?? m;
}
