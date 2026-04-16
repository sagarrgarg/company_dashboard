import { useEffect, useMemo, useState } from "react";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { useSkuAssortment } from "@/hooks/useOverview";
import { cn, formatINRShort, formatPct } from "@/lib/utils";
import type { IntentFilter, PeriodSelection, SkuRow, TaxMode } from "@/types/mis";

interface Props {
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
	onCompanyResolved?: (company: string) => void;
}

const INTENTS: Array<{ key: IntentFilter; label: string }> = [
	{ key: "all", label: "All" },
	{ key: "b2c", label: "B2C" },
	{ key: "b2b", label: "B2B" },
];

const PAGE_SIZE = 50;

type SortField =
	| "revenue"
	| "qty"
	| "gm_pct"
	| "cm2_pct"
	| "cm3_pct"
	| "cogs"
	| "alloc_freight"
	| "alloc_marketing";

export function AssortmentPage({
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
	onCompanyResolved,
}: Props) {
	const [intent, setIntent] = useState<IntentFilter>("all");
	const [search, setSearch] = useState("");
	const [showAll, setShowAll] = useState(false);
	const [sortField, setSortField] = useState<SortField>("revenue");
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

	const { data, error, isLoading } = useSkuAssortment(taxMode, period, intent);
	const res = data?.message;

	useEffect(() => {
		if (res?.company) onCompanyResolved?.(res.company);
	}, [res?.company, onCompanyResolved]);

	const filtered = useMemo<SkuRow[]>(() => {
		if (!res) return [];
		const q = search.trim().toLowerCase();
		const rows = q
			? res.rows.filter(
					(r) =>
						r.item_code.toLowerCase().includes(q) ||
						r.item_name.toLowerCase().includes(q) ||
						r.item_group.toLowerCase().includes(q),
				)
			: res.rows;
		const sorted = [...rows].sort((a, b) => {
			const av = a[sortField];
			const bv = b[sortField];
			return sortDir === "desc" ? bv - av : av - bv;
		});
		return sorted;
	}, [res, search, sortField, sortDir]);

	const visible = showAll ? filtered : filtered.slice(0, PAGE_SIZE);
	const taxLabel = taxMode === "incl" ? "Tax-inclusive" : "Tax-exclusive";

	const sortClick = (field: SortField) => {
		if (field === sortField) setSortDir(sortDir === "desc" ? "asc" : "desc");
		else {
			setSortField(field);
			setSortDir("desc");
		}
	};

	return (
		<>
			<header className="flex justify-between items-start mb-6 gap-4">
				<div>
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						SKU Assortment
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
						{res?.company ?? "SKUs"}
					</h1>
					<div className="text-[12px] text-text-2 mt-1.5 font-medium">
						{res ? `${res.period.label} · ${taxLabel} · ${filtered.length} of ${res.totals.sku_count} SKUs` : "loading…"}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<PeriodPicker value={period} onChange={onPeriodChange} />
					<TaxModeTabs value={taxMode} onChange={onTaxModeChange} />
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
						Allocations:{" "}
						<span className="font-semibold text-text-2">
							freight {formatPct(res.allocation.freight_pct)}
						</span>{" "}
						·{" "}
						<span className="font-semibold text-text-2">
							pkg {formatPct(res.allocation.packaging_pct)}
						</span>{" "}
						·{" "}
						<span className="font-semibold text-text-2">
							txn {formatPct(res.allocation.commission_pct)}
						</span>{" "}
						·{" "}
						<span className="font-semibold text-text-2">
							mkt {formatPct(res.allocation.marketing_pct)}
						</span>{" "}
						of company revenue
					</div>
				)}
			</div>

			{isLoading && <div className="card animate-pulse h-96" />}
			{error && (
				<div className="card">
					<div className="card-title text-red">Unable to load SKUs</div>
					<p className="text-[12px] text-text-2">{error.message}</p>
				</div>
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
										<SortTh
											field="qty"
											label="Units"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<SortTh
											field="revenue"
											label="Revenue"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<SortTh
											field="cogs"
											label="COGS"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<SortTh
											field="gm_pct"
											label="GM %"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<SortTh
											field="alloc_freight"
											label="Freight"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<Th>Pkg</Th>
										<Th>Txn</Th>
										<SortTh
											field="alloc_marketing"
											label="Mkt"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<SortTh
											field="cm2_pct"
											label="CM2 %"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										<SortTh
											field="cm3_pct"
											label="CM3 %"
											currentField={sortField}
											currentDir={sortDir}
											onClick={sortClick}
										/>
										{res.month_keys.map((mk) => (
											<Th key={mk} title={mk}>
												{shortMonth(mk)}
											</Th>
										))}
									</tr>
								</thead>
								<tbody>
									{visible.map((r, i) => (
										<tr key={r.item_code} className="border-b border-border hover:bg-surface-2/60">
											<Td sticky className="text-text-3 text-right">{i + 1}</Td>
											<Td sticky align="left">
												<div className="font-semibold text-text leading-tight">{r.item_code}</div>
												<div className="text-[10px] text-text-3 truncate max-w-[220px]" title={r.item_name}>
													{r.item_name}
												</div>
											</Td>
											<Td sticky align="left">
												<span className="text-text-2">{r.item_group}</span>
												<div className="text-[10px] text-text-4">{r.intent}</div>
											</Td>
											<Td>{Math.round(r.qty).toLocaleString("en-IN")}</Td>
											<Td className="font-semibold text-text">{formatINRShort(r.revenue)}</Td>
											<Td className="text-text-2">{formatINRShort(r.cogs)}</Td>
											<Td className={pctColor(r.gm_pct, 5, 0)}>{formatPct(r.gm_pct)}</Td>
											<Td className="text-amber">{formatINRShort(r.alloc_freight)}</Td>
											<Td className="text-text-3">{formatINRShort(r.alloc_packaging)}</Td>
											<Td className="text-text-3">{formatINRShort(r.alloc_commission)}</Td>
											<Td className="text-amber">{formatINRShort(r.alloc_marketing)}</Td>
											<Td className={pctColor(r.cm2_pct, 3, 0)}>{formatPct(r.cm2_pct)}</Td>
											<Td className={pctColor(r.cm3_pct, 2, 0)}>{formatPct(r.cm3_pct)}</Td>
											{res.month_keys.map((mk) => {
												const v = r.monthly[mk] ?? 0;
												return (
													<Td key={mk} className={v > 0 ? "text-text-2" : "text-text-4"}>
														{v > 0 ? formatINRShort(v) : "—"}
													</Td>
												);
											})}
										</tr>
									))}
									{visible.length === 0 && (
										<tr>
											<td colSpan={13 + res.month_keys.length} className="py-12 text-center text-text-3">
												No SKUs match this filter.
											</td>
										</tr>
									)}
								</tbody>
							</table>
						</div>
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
				"px-2 py-2 text-[10px] font-semibold tracking-[0.06em] uppercase text-text-3 border-b border-border bg-surface",
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
	currentField,
	currentDir,
	onClick,
}: {
	field: SortField;
	label: string;
	currentField: SortField;
	currentDir: "asc" | "desc";
	onClick: (field: SortField) => void;
}) {
	const active = field === currentField;
	return (
		<th
			className={cn(
				"px-2 py-2 text-[10px] font-semibold tracking-[0.06em] uppercase border-b border-border bg-surface text-right cursor-pointer select-none",
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
}: {
	children: React.ReactNode;
	sticky?: boolean;
	align?: "left" | "right";
	className?: string;
}) {
	return (
		<td
			className={cn(
				"px-2 py-1.5",
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

function shortMonth(key: string): string {
	const [, m] = key.split("-");
	const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	return MONTHS[Number(m) - 1] ?? m;
}
