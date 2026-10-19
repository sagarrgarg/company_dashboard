import { useEffect, useMemo, useState } from "react";
import { Explain } from "@/components/explain/Explain";
import { explainSku } from "@/lib/explain";
import { useUrlParam } from "@/lib/urlState";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { DownloadButtons } from "@/components/widgets/DownloadButtons";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { DataQualityBanner } from "@/components/widgets/DataQualityBanner";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { MarginValue, SoonValue } from "@/components/widgets/MarginValue";
import { useSkuAssortment } from "@/hooks/useOverview";
import { useComingSoon } from "@/hooks/useUiFlags";
import {
	cn,
	costExceedsRevenue,
	formatINR,
	formatNumber,
	formatPct,
	marginState,
	monthLabel,
	partialMonthKeys,
} from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { IntentFilter, SkuRow } from "@/types/mis";

const INTENTS: Array<{ key: IntentFilter; label: string }> = [
	{ key: "all", label: "All" },
	{ key: "b2c", label: "B2C" },
	{ key: "b2b", label: "B2B" },
];

const INTENT_KEYS: readonly IntentFilter[] = ["all", "b2c", "b2b"] as const;

const PAGE_SIZE = 50;
/** Fallback for data_quality.rules.min_revenue_for_pct. */
const DEFAULT_MIN_REVENUE = 1000;

type SortField =
	| "revenue"
	| "qty"
	| "cogs"
	| "gp"
	| "gm_pct"
	| "alloc_freight"
	| "alloc_scheme"
	| "alloc_marketing"
	| "cm2_pct"
	| "cm3";

/** Columns before the month columns: #, SKU, group, units, revenue, COGS, GP, GM%,
 *  freight, pkg, txn, scheme, mkt, CM2%, CM3. */
const FIXED_COLS = 15;

export function AssortmentPage({ query, onTaxModeChange, onPeriodChange, onLoaded, onRefreshed }: MisPageProps) {
	const [intent, setIntent] = useUrlParam<IntentFilter>("intent", "all", INTENT_KEYS);
	const [search, setSearch] = useState("");
	const [showAll, setShowAll] = useState(false);
	const [sortField, setSortField] = useState<SortField>("revenue");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
	const flags = useComingSoon();

	const { data, error, isLoading } = useSkuAssortment(query, intent);
	const res = data?.message;

	useEffect(() => {
		if (res) onLoaded(res.company);
	}, [res, onLoaded]);

	const minRevenue = res?.data_quality?.rules?.min_revenue_for_pct ?? DEFAULT_MIN_REVENUE;
	const lowRevenue = (r: SkuRow) => Math.abs(r.revenue_excl) < minRevenue;

	const filtered = useMemo<SkuRow[]>(() => {
		if (!res) return [];
		const q = search.trim().toLowerCase();
		const rows = q
			? res.rows.filter(
					(r) =>
						r.item_code.toLowerCase().includes(q) ||
						(r.item_name ?? "").toLowerCase().includes(q) ||
						(r.item_group ?? "").toLowerCase().includes(q),
				)
			: res.rows;
		return [...rows].sort((a, b) => {
			// Below the revenue floor (margins n/a) always sorts last (F11).
			const la = lowRevenue(a) ? 1 : 0;
			const lb = lowRevenue(b) ? 1 : 0;
			if (la !== lb) return la - lb;
			const av = a[sortField];
			const bv = b[sortField];
			// Missing values (null %) sort last in either direction.
			if (av == null && bv == null) return 0;
			if (av == null) return 1;
			if (bv == null) return -1;
			return sortDir === "desc" ? bv - av : av - bv;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [res, search, sortField, sortDir, minRevenue]);

	const sums = useMemo(() => {
		const rows = res?.rows ?? [];
		const sum = (f: (r: SkuRow) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
		return {
			gp: sum((r) => r.gp),
			freight: sum((r) => r.alloc_freight),
			packaging: sum((r) => r.alloc_packaging),
			commission: sum((r) => r.alloc_commission),
			scheme: sum((r) => r.alloc_scheme),
			marketing: sum((r) => r.alloc_marketing),
			cm3: sum((r) => r.cm3),
		};
	}, [res]);

	const visible = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
	const revBasis = res ? (res.basis?.revenue === "incl" ? "incl. tax" : "ex-tax") : query.taxMode === "incl" ? "incl. tax" : "ex-tax";
	const partial = res ? partialMonthKeys(res.period) : new Set<string>();
	const hideGp = flags.gross_profit;

	const impossible = Boolean(
		res?.rows.some(
			(r) =>
				marginState(r.gm_pct) === "bogus" ||
				marginState(r.cm2_pct) === "bogus" ||
				marginState(r.cm3_pct) === "bogus",
		),
	);
	const costOver = Boolean(res?.rows.some((r) => costExceedsRevenue(r.cogs, r.revenue_excl)));

	const sortClick = (field: SortField) => {
		if (field === sortField) setSortDir(sortDir === "desc" ? "asc" : "desc");
		else {
			setSortField(field);
			setSortDir("desc");
		}
	};
	const sortProps = { currentField: sortField, currentDir: sortDir, onClick: sortClick };

	const qtyByUom = res
		? Object.entries(res.totals.qty_by_uom ?? {})
				.map(([uom, q]) => `${formatNumber(q)} ${uom}`)
				.join(" · ")
		: "";

	return (
		<>
			<PreparedReportHeader
				refreshedAt={res?.refreshed_at}
				stale={res?.stale}
				section="mis"
				onRefreshed={onRefreshed}
			/>
			<header className="flex justify-between items-start mb-6 gap-4">
				<div>
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						SKU Assortment
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
						{res?.company ?? (query.company || "SKUs")}
					</h1>
					<div className="text-[12px] text-text-2 mt-1.5 font-medium">
						{res
							? `${res.period.label} · revenue ${revBasis}, margins ex-tax · ${filtered.length} of ${res.totals.sku_count} SKUs`
							: isLoading
								? "loading…"
								: ""}
					</div>
					{qtyByUom && <div className="text-[10.5px] text-text-3 mt-0.5">Quantity sold: {qtyByUom}</div>}
				</div>
				<div className="flex items-center gap-2 flex-wrap justify-end">
					<DownloadButtons
						taxMode={query.taxMode}
						period={query.period}
						company={query.company}
						intent={intent}
					/>
					<PeriodPicker value={query.period} onChange={onPeriodChange} company={query.company} />
					<TaxModeTabs value={query.taxMode} onChange={onTaxModeChange} />
				</div>
			</header>

			<div className="flex items-center gap-3 mb-4 flex-wrap">
				<div
					className="inline-flex items-center p-1 rounded-full border border-border-md bg-surface shadow-[0_1px_2px_rgba(40,30,15,.05)]"
					role="tablist"
				>
					{INTENTS.map((it) => (
						<button
							key={it.key}
							type="button"
							onClick={() => setIntent(it.key)}
							className={cn(
								"px-3.5 py-[5px] text-[11px] font-semibold rounded-full transition-all tracking-wide",
								intent === it.key
									? "bg-green text-white shadow-[0_1px_2px_rgba(31,95,51,.25)]"
									: "text-text-2 hover:bg-surface-2",
							)}
						>
							{it.label}
						</button>
					))}
				</div>
				<input
					type="search"
					placeholder="Search SKU code, name, or category…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="flex-1 min-w-[260px] max-w-md px-3 py-1.5 text-[12px] bg-surface border border-border-md rounded-lg text-text placeholder:text-text-3"
				/>
				{res && (
					<div className="ml-auto text-[10.5px] text-text-3">
						Allocations (of ex-tax revenue):{" "}
						<span className="font-semibold text-text-2">freight {formatPct(res.allocation.freight_pct, 2)}</span> ·{" "}
						<span className="font-semibold text-text-2">pkg {formatPct(res.allocation.packaging_pct, 2)}</span> ·{" "}
						<span className="font-semibold text-text-2">txn {formatPct(res.allocation.commission_pct, 2)}</span> ·{" "}
						<span className="font-semibold text-text-2">scheme {formatPct(res.allocation.scheme_pct, 2)}</span> ·{" "}
						<span className="font-semibold text-text-2">mkt {formatPct(res.allocation.marketing_pct, 2)}</span>
					</div>
				)}
			</div>

			{res && <DataQualityBanner dq={res.data_quality} impossibleMargins={impossible} costOverRevenue={costOver} />}

			{isLoading && !res && <div className="card animate-pulse h-96" />}
			{error && !res && (
				<ErrorCard
					title="Unable to load SKUs"
					error={error}
					period={query.period}
					onPeriodChange={onPeriodChange}
				/>
			)}

			{res && (
				<>
					<div className="card !p-0 overflow-hidden">
						<div className="overflow-x-auto">
							<table className="w-full text-[11.5px] tabular-nums border-collapse">
								<thead>
									<tr>
										<Th sticky width="44px">#</Th>
										<Th sticky width="140px" align="left">
											SKU
										</Th>
										<Th sticky width="140px" align="left">
											Item Group
										</Th>
										<SortTh field="qty" label="Units" {...sortProps} />
										<SortTh field="revenue" label={`Revenue · ${revBasis}`} {...sortProps} />
										<SortTh field="cogs" label="COGS" title="Stock-ledger cost (flagged lines excluded)" {...sortProps} />
										<SortTh field="gp" label="GP" title="Ex-tax revenue − COGS" {...sortProps} />
										<SortTh field="gm_pct" label="GM %" title="GP ÷ ex-tax revenue" {...sortProps} />
										<SortTh field="alloc_freight" label="Freight" {...sortProps} />
										<Th>Pkg</Th>
										<Th>Txn</Th>
										<SortTh field="alloc_scheme" label="Scheme" {...sortProps} />
										<SortTh field="alloc_marketing" label="Mkt" {...sortProps} />
										<SortTh field="cm2_pct" label="CM2 %" {...sortProps} />
										<SortTh
											field="cm3"
											label="CM3"
											title="GP − freight − pkg − txn − scheme − mkt"
											{...sortProps}
										/>
										{res.month_keys.map((mk) => (
											<Th key={mk} title={partial.has(mk) ? `${mk} — partial month` : mk}>
												{monthLabel(mk)}
												{partial.has(mk) && <span className="text-amber">*</span>}
											</Th>
										))}
									</tr>
								</thead>
								<tbody>
									{visible.map((r, i) => (
										<tr
											key={r.item_code}
											className={cn("border-b border-border hover:bg-surface-2/60", lowRevenue(r) && "text-text-3")}
										>
											<Td sticky className="text-text-3 text-right">
												{i + 1}
											</Td>
											<Td sticky align="left">
												<div className="font-semibold text-text leading-tight">
													{r.item_code}
													{r.flagged_lines > 0 && (
														<span
															className="ml-1 text-amber cursor-help"
															title={`${r.flagged_lines} invoice line${r.flagged_lines === 1 ? "" : "s"} with impossible cost (${formatINR(r.flagged_cost)}) excluded from COGS`}
														>
															⚠
														</span>
													)}
												</div>
												<div className="text-[10px] text-text-3 truncate max-w-[220px]" title={r.item_name}>
													{r.item_name}
												</div>
											</Td>
											<Td sticky align="left">
												<span className="text-text-2">{r.item_group}</span>
												<div className="text-[10px] text-text-4">{r.intent}</div>
											</Td>
											<Td>
												{formatNumber(r.qty)}
												<span className="text-[9.5px] text-text-4 ml-0.5">{r.stock_uom}</span>
											</Td>
											<Td className="font-semibold text-text">{formatINR(r.revenue)}</Td>
											<Td className="text-text-2">{formatINR(r.cogs)}</Td>
											<Td className="text-text-2">{hideGp ? <SoonValue /> : formatINR(r.gp)}</Td>
											<Td>
												<SkuExplain r={r} level="gm" periodLabel={res.period.label} basis={res.allocation.basis} hideGp={hideGp}>
													<MarginValue pct={r.gm_pct} colorFor={(p) => pctColor(p, 5, 0)} />
												</SkuExplain>
											</Td>
											<Td className="text-amber">{formatINR(r.alloc_freight)}</Td>
											<Td className="text-text-3">{formatINR(r.alloc_packaging)}</Td>
											<Td className="text-text-3">{formatINR(r.alloc_commission)}</Td>
											<Td className="text-text-3">{formatINR(r.alloc_scheme)}</Td>
											<Td className="text-amber">{formatINR(r.alloc_marketing)}</Td>
											<Td>
												<SkuExplain r={r} level="cm2" periodLabel={res.period.label} basis={res.allocation.basis} hideGp={hideGp}>
													<MarginValue pct={r.cm2_pct} colorFor={(p) => pctColor(p, 3, 0)} />
												</SkuExplain>
											</Td>
											<Td>
												<div className="text-text-2">{formatINR(r.cm3)}</div>
												<div className="text-[10px]">
													<SkuExplain r={r} level="cm3" periodLabel={res.period.label} basis={res.allocation.basis} hideGp={hideGp}>
														<MarginValue pct={r.cm3_pct} colorFor={(p) => pctColor(p, 2, 0)} />
													</SkuExplain>
												</div>
											</Td>
											{res.month_keys.map((mk) => {
												const v = r.monthly[mk];
												return (
													<Td key={mk} className={v ? "text-text-2" : "text-text-4"}>
														{v ? formatINR(v) : "—"}
													</Td>
												);
											})}
										</tr>
									))}
									{visible.length === 0 && (
										<tr>
											<td colSpan={FIXED_COLS + res.month_keys.length} className="py-12 text-center text-text-3">
												No SKUs match this filter.
											</td>
										</tr>
									)}
								</tbody>
								<tfoot className="text-[11.5px]">
									<tr className="bg-surface-2 font-semibold border-t-2 border-border-md">
										<Td colSpan={4} align="left" className="text-text">
											All {formatNumber(res.totals.sku_count)} SKUs
											{search && <span className="font-normal text-text-3"> (ignores search)</span>}
										</Td>
										<Td className="text-text">{formatINR(res.totals.revenue)}</Td>
										<Td>{formatINR(res.totals.cogs)}</Td>
										<Td>{hideGp ? <SoonValue /> : formatINR(sums.gp)}</Td>
										<Td />
										<Td>{formatINR(sums.freight)}</Td>
										<Td>{formatINR(sums.packaging)}</Td>
										<Td>{formatINR(sums.commission)}</Td>
										<Td>{formatINR(sums.scheme)}</Td>
										<Td>{formatINR(sums.marketing)}</Td>
										<Td />
										<Td>{formatINR(sums.cm3)}</Td>
										<td colSpan={res.month_keys.length} />
									</tr>
									<FootLine
										label="Unallocated cost of goods (GL − stock-ledger cost)"
										value={hideGp ? null : -res.totals.cogs_unallocated}
										months={res.month_keys.length}
									/>
									<FootLine
										label="Direct costs (GL)"
										value={hideGp ? null : -res.totals.direct_costs}
										months={res.month_keys.length}
									/>
									<tr className="bg-surface-2 font-semibold">
										<Td colSpan={6} align="left" className="text-text">
											Gross profit
											<span className="font-normal text-text-3">
												{" "}
												= Σ SKU GP − unallocated cost − direct costs
												{intent === "all" ? " · ties to Overview CM1" : ""}
											</span>
										</Td>
										<Td className="text-text">{hideGp ? <SoonValue /> : formatINR(res.totals.gp)}</Td>
										<Td>
											<MarginValue pct={res.totals.gm_pct} colorFor={(p) => pctColor(p, 5, 0)} />
										</Td>
										<td colSpan={FIXED_COLS - 8 + res.month_keys.length} />
									</tr>
								</tfoot>
							</table>
						</div>
					</div>

					<div className="mt-2 text-[10.5px] text-text-3 leading-[1.6]">
						Per row: GP − freight − pkg − txn − scheme − mkt = CM3. Margins are on ex-tax revenue and read
						“n/a” below {formatINR(minRevenue)} of revenue (sorted last).
						{res.totals.flagged_lines > 0 && (
							<>
								{" "}
								⚠ marks SKUs with flagged invoice lines ({formatNumber(res.totals.flagged_lines)} lines,{" "}
								{formatINR(res.totals.flagged_cost)} cost kept out of COGS).
							</>
						)}
						{partial.size > 0 && <> * partial month.</>}
					</div>

					{filtered.length > PAGE_SIZE && (
						<div className="mt-3 flex items-center gap-3 text-[12px] text-text-3">
							<span>
								Showing <strong className="text-text">{visible.length}</strong> of{" "}
								<strong className="text-text">{filtered.length}</strong> SKUs
							</span>
							<button
								type="button"
								onClick={() => setShowAll((x) => !x)}
								className="px-3 py-1 text-[11.5px] font-semibold rounded-full bg-surface border border-border-md hover:bg-surface-2 text-text-2"
							>
								{showAll ? "Show top 50" : `Show all ${filtered.length}`}
							</button>
						</div>
					)}
				</>
			)}
		</>
	);
}

function FootLine({ label, value, months }: { label: string; value: number | null; months: number }) {
	return (
		<tr className="border-t border-border text-text-2">
			<Td colSpan={6} align="left">
				{label}
			</Td>
			<Td className={cn(value != null && value < 0 && "text-red")}>
				{value == null ? <SoonValue /> : formatINR(value)}
			</Td>
			<td colSpan={FIXED_COLS - 7 + months} />
		</tr>
	);
}

function Th({
	children,
	sticky,
	width,
	align = "right",
	title,
}: {
	children: React.ReactNode;
	sticky?: boolean;
	width?: string;
	align?: "left" | "right";
	title?: string;
}) {
	return (
		<th
			title={title}
			style={width ? { width, minWidth: width } : undefined}
			className={cn(
				"px-2 py-2 text-[10px] font-semibold tracking-[0.06em] uppercase text-text-3 border-b border-border bg-surface whitespace-nowrap",
				align === "left" ? "text-left" : "text-right",
				sticky && "sticky top-0 z-10",
			)}
		>
			{children}
		</th>
	);
}

function SortTh({
	field,
	label,
	title,
	currentField,
	currentDir,
	onClick,
}: {
	field: SortField;
	label: string;
	title?: string;
	currentField: SortField;
	currentDir: "asc" | "desc";
	onClick: (field: SortField) => void;
}) {
	const active = field === currentField;
	return (
		<th
			title={title}
			className={cn(
				"px-2 py-2 text-[10px] font-semibold tracking-[0.06em] uppercase border-b border-border bg-surface text-right cursor-pointer select-none whitespace-nowrap",
				active ? "text-green" : "text-text-3 hover:text-text-2",
			)}
			onClick={() => onClick(field)}
		>
			{label}
			{active && <span className="ml-0.5">{currentDir === "desc" ? "↓" : "↑"}</span>}
		</th>
	);
}

function Td({
	children,
	sticky,
	align = "right",
	className,
	colSpan,
}: {
	children?: React.ReactNode;
	sticky?: boolean;
	align?: "left" | "right";
	className?: string;
	colSpan?: number;
}) {
	return (
		<td
			colSpan={colSpan}
			className={cn(
				"px-2 py-1.5 whitespace-nowrap",
				align === "left" ? "text-left" : "text-right",
				sticky && "bg-surface",
				className,
			)}
		>
			{children}
		</td>
	);
}

function pctColor(pct: number, goodAbove: number, neutralAbove: number): string {
	if (pct > goodAbove) return "text-green font-semibold";
	if (pct > neutralAbove) return "text-amber";
	return "text-red font-semibold";
}

/** Small explain on a SKU margin cell (rev ex-tax, stock cost, GP, allocations). */
function SkuExplain({
	r,
	level,
	periodLabel,
	basis,
	hideGp,
	children,
}: {
	r: SkuRow;
	level: "gm" | "cm2" | "cm3";
	periodLabel: string;
	basis: string;
	hideGp: boolean;
	children: React.ReactNode;
}) {
	// Rupee GP is a "Coming soon" figure when flagged — don't reveal it in the breakdown.
	if (hideGp) return <>{children}</>;
	return (
		<Explain
			content={() =>
				explainSku(r, level, { periodLabel, basis, itemHref: `/app/item/${encodeURIComponent(r.item_code)}` })
			}
			label={`${level === "gm" ? "Gross margin" : level.toUpperCase()} of ${r.item_code}, has breakdown`}
		>
			{children}
		</Explain>
	);
}
