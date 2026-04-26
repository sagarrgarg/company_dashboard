import { useState, useCallback } from "react";
import {
	useWcOverview,
	useBankDetail,
	useTradeReceivable,
	useTradePayable,
	useStockDetail,
} from "@/hooks/useWc";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { formatINRShort } from "@/lib/utils";
import type {
	AgingBucket,
	BankAccount,
	BankTrendPoint,
	PartyRow,
	ReorderAlert,
	StockGroup,
	WarehouseTreeNode,
} from "@/types/wc";

/* ── Formatters ─────────────────────────────────────────────────────────── */

function fmtCr(v: number): string {
	if (Math.abs(v) >= 1_00_00_000) return `₹${(v / 1_00_00_000).toFixed(2)} Cr`;
	if (Math.abs(v) >= 1_00_000) return `₹${(v / 1_00_000).toFixed(1)} L`;
	return formatINRShort(v);
}

function fmtDays(v: number): string {
	return `${Math.round(v)}d`;
}

/* ── Shared sub-components ──────────────────────────────────────────────── */

function SectionHeader({
	color,
	title,
	tag,
}: {
	color: string;
	title: string;
	tag: string;
}) {
	return (
		<div className="flex items-center gap-3 mb-4 mt-10 first:mt-0">
			<span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
			<span className="font-semibold text-[15px] tracking-tight" style={{ color }}>
				{title}
			</span>
			<span className="flex-1 h-px bg-border" />
			<span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">
				{tag}
			</span>
		</div>
	);
}

function ProgressBar({
	label,
	pct,
	color,
	valueStr,
}: {
	label: string;
	pct: number;
	color: string;
	valueStr: string;
}) {
	return (
		<div className="grid grid-cols-[1fr_100px_8px_72px] items-center gap-2 mb-2">
			<span className="text-[12.5px] font-medium truncate">{label}</span>
			<div className="h-[7px] bg-surface-2 rounded-full overflow-hidden border border-border">
				<div
					className="h-full rounded-full transition-all duration-700"
					style={{ width: `${Math.min(pct, 100)}%`, background: color }}
				/>
			</div>
			<span className="text-[10px] font-mono text-text-3 text-right">{Math.round(pct)}%</span>
			<span className="text-[12px] font-mono font-semibold text-right" style={{ color }}>
				{valueStr}
			</span>
		</div>
	);
}

function StatBox({
	label,
	value,
	color,
	bg,
}: {
	label: string;
	value: string;
	color: string;
	bg: string;
}) {
	return (
		<div className="rounded-[10px] py-3 px-4 text-center" style={{ background: bg }}>
			<div
				className="text-[9.5px] font-semibold tracking-[0.08em] uppercase mb-1 font-mono"
				style={{ color }}
			>
				{label}
			</div>
			<div className="text-[20px] font-bold tracking-tight" style={{ color }}>
				{value}
			</div>
		</div>
	);
}

function Pill({
	children,
	variant,
}: {
	children: React.ReactNode;
	variant: "up" | "down" | "warn" | "info" | "soft";
}) {
	const styles = {
		up: "bg-green-bg text-green",
		down: "bg-red-bg text-red",
		warn: "bg-amber-bg text-amber",
		info: "bg-blue-bg text-blue",
		soft: "bg-surface-2 text-text-3 border border-border",
	};
	return (
		<span
			className={`inline-flex items-center gap-1 text-[10.5px] font-semibold font-mono px-2 py-[2px] rounded-[5px] ${styles[variant]}`}
		>
			{children}
		</span>
	);
}

/* ── KPI Card ───────────────────────────────────────────────────────────── */

function KpiCard({
	label,
	value,
	color,
	icon,
	footer,
}: {
	label: string;
	value: string;
	color: string;
	icon: string;
	footer?: React.ReactNode;
}) {
	return (
		<div className="kpi relative overflow-hidden">
			<div
				className="absolute top-0 left-0 right-0 h-[3px] rounded-t-[12px]"
				style={{ background: color }}
			/>
			<div
				className="w-9 h-9 rounded-[10px] flex items-center justify-center text-[18px] mb-3"
				style={{ background: `${color}18` }}
			>
				{icon}
			</div>
			<div className="kpi-lbl">{label}</div>
			<div className="kpi-val" style={{ color }}>
				{value}
			</div>
			{footer && <div className="kpi-meta mt-2 flex-wrap">{footer}</div>}
		</div>
	);
}

/* ── Bank Detail Card ───────────────────────────────────────────────────── */

function BankSection({ refreshKey }: { refreshKey: number }) {
	const { data, isLoading } = useBankDetail(refreshKey);
	const d = data?.message;
	if (isLoading || !d) return <LoadingCard />;
	const total = d.total_balance;

	return (
		<>
			<SectionHeader
				color="var(--green)"
				title="Bank Balance — Account-wise Breakup"
				tag={`GL Entry · ${d.account_count} accounts`}
			/>
			<div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3.5">
				<div className="card">
					<div className="flex justify-between items-start mb-4">
						<div>
							<div className="card-title !mb-0">Account-wise Balance</div>
							<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">
								{d.account_count} active bank accounts
							</div>
						</div>
						<div className="text-right">
							<div className="text-[26px] font-bold tracking-tight text-green">
								{fmtCr(total)}
							</div>
						</div>
					</div>
					{d.accounts.map((a: BankAccount) => {
						const pct = total > 0 ? (a.balance / total) * 100 : 0;
						return (
							<ProgressBar
								key={a.account}
								label={a.account.replace(/ - .+$/, "")}
								pct={pct}
								color="var(--green-mid)"
								valueStr={fmtCr(a.balance)}
							/>
						);
					})}
					{d.accounts.length > 0 && (
						<div className="text-[10px] text-text-3 font-mono mt-2">
							Last entry:{" "}
							{d.accounts
								.filter((a: BankAccount) => a.last_posting_date)
								.map((a: BankAccount) => `${a.account.replace(/ - .+$/, "")} (${a.last_posting_date})`)
								.join(" · ")}
						</div>
					)}
					<hr className="border-border my-3" />
					<div className="grid grid-cols-3 gap-2.5">
						<StatBox
							label="Cash Burn/Mo"
							value={fmtCr(d.cash_burn_monthly)}
							color="var(--green)"
							bg="var(--green-bg)"
						/>
						<StatBox
							label="Days Cash on Hand"
							value={fmtDays(d.days_cash_on_hand)}
							color="var(--blue)"
							bg="var(--blue-bg)"
						/>
						<StatBox
							label="Net Cash Position"
							value={fmtCr(total)}
							color="var(--purple)"
							bg="var(--purple-bg)"
						/>
					</div>
				</div>
				<div className="card">
					<div className="card-title !mb-0">6-Month Bank Trend</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
						Opening balance each month
					</div>
					<BankTrendSvg trend={d.trend} />
				</div>
			</div>
		</>
	);
}

function BankTrendSvg({ trend }: { trend: BankTrendPoint[] }) {
	if (!trend.length) return null;
	const maxBal = Math.max(...trend.map((t) => t.balance), 1);
	const w = 220;
	const h = 110;
	const padTop = 15;
	const padBot = 20;
	const usableH = h - padTop - padBot;
	const step = w / Math.max(trend.length - 1, 1);

	const pts = trend.map((t, i) => ({
		x: i * step,
		y: padTop + usableH - (t.balance / maxBal) * usableH,
		...t,
	}));
	const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");
	const polygon = `${polyline} ${pts[pts.length - 1].x},${padTop + usableH} ${pts[0].x},${padTop + usableH}`;

	return (
		<svg viewBox={`0 0 ${w} ${h + 10}`} className="w-full">
			<defs>
				<linearGradient id="bankGrad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor="var(--green-mid)" stopOpacity="0.25" />
					<stop offset="100%" stopColor="var(--green-mid)" stopOpacity="0" />
				</linearGradient>
			</defs>
			<polygon points={polygon} fill="url(#bankGrad)" />
			<polyline
				points={polyline}
				fill="none"
				stroke="var(--green-mid)"
				strokeWidth="2.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{pts.map((p, i) => (
				<g key={i}>
					<circle
						cx={p.x}
						cy={p.y}
						r={i === pts.length - 1 ? 5 : 3.5}
						fill="var(--green-mid)"
						stroke="white"
						strokeWidth={i === pts.length - 1 ? 2 : 1.5}
					/>
					<text
						x={p.x}
						y={padTop + usableH + 14}
						textAnchor="middle"
						className="fill-text-3"
						style={{ fontSize: 8, fontFamily: "monospace" }}
					>
						{p.month.toUpperCase()}
					</text>
				</g>
			))}
		</svg>
	);
}

/* ── Trade Receivable ───────────────────────────────────────────────────── */

function ReceivableSection({ refreshKey }: { refreshKey: number }) {
	const { data, isLoading } = useTradeReceivable(refreshKey);
	const d = data?.message;
	if (isLoading || !d) return <LoadingCard />;

	const agingColors = ["var(--green-mid)", "var(--amber)", "var(--red)", "#991B1B", "#991B1B"];

	return (
		<>
			<SectionHeader
				color="var(--blue)"
				title="Trade Receivable — Detailed Breakup"
				tag="FIFO Aging · Outstanding"
			/>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
				<div className="card">
					<div className="flex justify-between items-start mb-4">
						<div>
							<div className="card-title !mb-0">Receivable Aging</div>
							<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">
								Days since due date
							</div>
						</div>
						<div className="text-[26px] font-bold tracking-tight text-blue">
							{fmtCr(d.aging.total_outstanding)}
						</div>
					</div>
					{d.aging.buckets.map((b: AgingBucket, i: number) => (
						<ProgressBar
							key={b.label}
							label={b.label}
							pct={b.pct}
							color={agingColors[i] ?? "var(--green-mid)"}
							valueStr={fmtCr(b.amount)}
						/>
					))}
					<hr className="border-border my-3" />
					<div className="grid grid-cols-2 gap-2.5">
						<StatBox
							label="Total Overdue"
							value={fmtCr(d.aging.total_overdue)}
							color="var(--red)"
							bg="var(--red-bg)"
						/>
						<StatBox label="DSO" value={fmtDays(d.dso)} color="var(--blue)" bg="var(--blue-bg)" />
					</div>
				</div>
				<div className="card">
					<div className="card-title !mb-0">Top Debtors by Outstanding</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
						Customer-wise · Sorted by amount
					</div>
					<PartyTable rows={d.top_debtors} groupField="customer_group" />
					<hr className="border-border my-3" />
					<div className="flex justify-between items-center">
						<span className="text-[12px] font-medium text-text-3">
							Collection Efficiency — MTD
						</span>
						<div className="flex items-center gap-2.5">
							<div className="w-[100px] h-[7px] bg-surface-2 rounded-full overflow-hidden border border-border">
								<div
									className="h-full bg-green-mid rounded-full"
									style={{ width: `${d.collection_efficiency}%` }}
								/>
							</div>
							<Pill variant="up">{d.collection_efficiency}%</Pill>
						</div>
					</div>
				</div>
			</div>
		</>
	);
}

/* ── Trade Payable ──────────────────────────────────────────────────────── */

function PayableSection({ refreshKey }: { refreshKey: number }) {
	const { data, isLoading } = useTradePayable(refreshKey);
	const d = data?.message;
	if (isLoading || !d) return <LoadingCard />;

	const agingColors = ["var(--green-mid)", "var(--amber)", "var(--red)", "#991B1B", "#991B1B"];

	return (
		<>
			<SectionHeader
				color="var(--red)"
				title="Trade Payable — Detailed Breakup"
				tag="FIFO Aging · Outstanding"
			/>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
				<div className="card">
					<div className="flex justify-between items-start mb-4">
						<div>
							<div className="card-title !mb-0">Payable Aging</div>
							<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">
								Current vs Overdue split
							</div>
						</div>
						<div className="text-[26px] font-bold tracking-tight text-red">
							{fmtCr(d.aging.total_outstanding)}
						</div>
					</div>
					{d.aging.buckets.map((b: AgingBucket, i: number) => (
						<ProgressBar
							key={b.label}
							label={b.label}
							pct={b.pct}
							color={agingColors[i] ?? "var(--green-mid)"}
							valueStr={fmtCr(b.amount)}
						/>
					))}
					<hr className="border-border my-3" />
					<div className="grid grid-cols-3 gap-2.5">
						<StatBox
							label="Total Overdue"
							value={fmtCr(d.aging.total_overdue)}
							color="var(--red)"
							bg="var(--red-bg)"
						/>
						<StatBox
							label="DPO"
							value={fmtDays(d.dpo)}
							color="var(--purple)"
							bg="var(--purple-bg)"
						/>
						<StatBox
							label="Advance Paid"
							value={fmtCr(d.advance_paid)}
							color="var(--blue)"
							bg="var(--blue-bg)"
						/>
					</div>
				</div>
				<div className="card">
					<div className="card-title !mb-0">Supplier-wise Payable</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
						Purchase Invoice · Sorted by outstanding
					</div>
					<PartyTable rows={d.top_creditors} groupField="supplier_group" />
				</div>
			</div>
		</>
	);
}

/* ── Party Table (shared for AR/AP) ─────────────────────────────────────── */

function PartyTable({
	rows,
	groupField,
}: {
	rows: PartyRow[];
	groupField: "customer_group" | "supplier_group";
}) {
	if (!rows.length) return <div className="text-[12px] text-text-3">No data</div>;

	const statusPill = (s: string) => {
		if (s === "Overdue") return <Pill variant="down">Overdue</Pill>;
		if (s === "Watch") return <Pill variant="warn">Watch</Pill>;
		return <Pill variant="up">Current</Pill>;
	};

	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-[12.5px]">
				<thead>
					<tr className="border-b border-border-md">
						<th className="text-left py-1.5 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-3">
							Party
						</th>
						<th className="text-left py-1.5 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-3">
							Group
						</th>
						<th className="text-right py-1.5 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-3">
							Outstanding
						</th>
						<th className="text-right py-1.5 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-3">
							Age
						</th>
						<th className="text-right py-1.5 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-3">
							Status
						</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.party} className="border-b border-border hover:bg-surface-2/50">
							<td className="py-2 px-2 font-medium truncate max-w-[180px]">
								{r.party_name || r.party}
							</td>
							<td className="py-2 px-2">
								<Pill variant="soft">
									{(r[groupField] || "—").replace(/ .*/, "").slice(0, 12)}
								</Pill>
							</td>
							<td className="py-2 px-2 text-right font-mono font-semibold">
								{formatINRShort(r.outstanding)}
							</td>
							<td className="py-2 px-2 text-right font-mono text-text-3">
								{r.age_days}d
							</td>
							<td className="py-2 px-2 text-right">{statusPill(r.status)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/* ── Stock In Hand ──────────────────────────────────────────────────────── */

function whLabel(name: string): string {
	return name.replace(/ - .+$/, "").replace(/_/g, " ");
}

function WarehouseTreeRow({
	node,
	total,
	depth,
	expanded,
	onToggle,
}: {
	node: WarehouseTreeNode;
	total: number;
	depth: number;
	expanded: Set<string>;
	onToggle: (name: string) => void;
}) {
	const isOpen = expanded.has(node.name);
	const pct = total > 0 ? (node.stock_value / total) * 100 : 0;

	return (
		<>
			<div
				className={`flex items-center py-[5px] border-b border-border/40 hover:bg-surface-2/40 ${node.is_group ? "cursor-pointer" : ""}`}
				style={{ paddingLeft: depth * 20 + 4 }}
				onClick={node.is_group ? () => onToggle(node.name) : undefined}
			>
				{/* chevron or dot */}
				<span className="w-5 shrink-0 flex items-center justify-center">
					{node.is_group ? (
						<svg
							className={`w-3.5 h-3.5 text-text-3 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
							viewBox="0 0 16 16"
							fill="currentColor"
						>
							<path d="M6 3l5 5-5 5V3z" />
						</svg>
					) : (
						<span className="w-1.5 h-1.5 rounded-full bg-purple/40" />
					)}
				</span>
				{/* name */}
				<span
					className={`flex-1 min-w-0 text-[12px] leading-tight ${node.is_group ? "font-semibold text-text-1" : "text-text-2"}`}
					title={node.name}
				>
					{whLabel(node.name)}
				</span>
				{/* pct pill */}
				<span className="text-[9px] font-mono text-text-3 tabular-nums w-[32px] text-right shrink-0 mr-2">
					{pct >= 1 ? `${Math.round(pct)}%` : pct > 0 ? "<1%" : ""}
				</span>
				{/* value */}
				<span
					className={`text-[11.5px] font-mono tabular-nums text-right shrink-0 w-[72px] ${node.is_group ? "font-semibold text-purple" : "font-medium text-text-2"}`}
				>
					{fmtCr(node.stock_value)}
				</span>
			</div>
			{node.is_group && isOpen &&
				node.children.map((child) => (
					<WarehouseTreeRow
						key={child.name}
						node={child}
						total={total}
						depth={depth + 1}
						expanded={expanded}
						onToggle={onToggle}
					/>
				))}
		</>
	);
}

function StockSection({ refreshKey }: { refreshKey: number }) {
	const { data, isLoading } = useStockDetail(refreshKey);
	const d = data?.message;
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const onToggle = useCallback((name: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}, []);

	if (isLoading || !d) return <LoadingCard />;

	const total = d.total_stock_value;
	const groupColors = [
		"var(--blue)",
		"var(--green-mid)",
		"var(--purple)",
		"var(--amber)",
		"var(--teal)",
		"var(--red)",
	];

	return (
		<>
			<SectionHeader
				color="var(--purple)"
				title="Stock in Hand — Warehouse & Category Breakup"
				tag={`Bin · ${d.warehouse_count} warehouses · Live`}
			/>
			<div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3.5">
				{/* Warehouse Tree — wider card */}
				<div className="card">
					<div className="flex justify-between items-start mb-3">
						<div>
							<div className="card-title !mb-0">By Warehouse</div>
							<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">
								Click groups to expand · {d.warehouse_count} locations
							</div>
						</div>
						<div className="text-[22px] font-bold tracking-tight text-purple">
							{fmtCr(total)}
						</div>
					</div>
					<div className="max-h-[500px] overflow-y-auto -mx-1 px-1">
						{d.warehouse_tree.map((node: WarehouseTreeNode) => (
							<WarehouseTreeRow
								key={node.name}
								node={node}
								total={total}
								depth={0}
								expanded={expanded}
								onToggle={onToggle}
							/>
						))}
					</div>
					<hr className="border-border my-3" />
					<div className="grid grid-cols-2 gap-2.5">
						<StatBox
							label="DIO"
							value={fmtDays(d.dio)}
							color="var(--amber)"
							bg="var(--amber-bg)"
						/>
						<StatBox
							label="SKUs Below Min"
							value={`${d.reorder_count}`}
							color="var(--red)"
							bg="var(--red-bg)"
						/>
					</div>
				</div>

				{/* Right column: Category + Reorder stacked */}
				<div className="flex flex-col gap-3.5">
					<div className="card">
						<div className="card-title !mb-0">By Item Category</div>
						<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
							Grouped by item group
						</div>
						{d.by_item_group.map((g: StockGroup, i: number) => {
							const pct = total > 0 ? (g.stock_value / total) * 100 : 0;
							return (
								<ProgressBar
									key={g.item_group}
									label={g.item_group}
									pct={pct}
									color={groupColors[i % groupColors.length]}
									valueStr={fmtCr(g.stock_value)}
								/>
							);
						})}
					</div>

					<div className="card">
						<div className="card-title !mb-0">Reorder Alerts</div>
						<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
							{d.reorder_count} SKUs below safety stock
						</div>
						{d.reorder_alerts.length === 0 ? (
							<div className="text-[12px] text-text-3">All items above safety stock</div>
						) : (
							d.reorder_alerts.map((r: ReorderAlert) => (
								<div
									key={r.item_code}
									className="grid grid-cols-[1fr_100px_64px] items-center gap-2 mb-2"
								>
									<span className="text-[12px] font-medium truncate" title={r.item_name}>
										{r.item_name || r.item_code}
									</span>
									<div className="h-[7px] bg-surface-2 rounded-full overflow-hidden border border-border">
										<div
											className="h-full rounded-full"
											style={{
												width: `${r.pct}%`,
												background: r.pct < 30 ? "var(--red)" : "var(--amber)",
											}}
										/>
									</div>
									<span
										className="text-[12px] font-mono font-semibold text-right"
										style={{ color: r.pct < 30 ? "var(--red)" : "var(--amber)" }}
									>
										{Math.round(r.actual_qty)} {r.stock_uom}
									</span>
								</div>
							))
						)}
					</div>
				</div>
			</div>
		</>
	);
}

/* ── Loading / Error states ─────────────────────────────────────────────── */

function LoadingCard() {
	return (
		<div className="card animate-pulse">
			<div className="h-4 bg-surface-2 rounded w-1/3 mb-3" />
			<div className="h-8 bg-surface-2 rounded w-1/2 mb-4" />
			<div className="h-3 bg-surface-2 rounded w-full mb-2" />
			<div className="h-3 bg-surface-2 rounded w-2/3" />
		</div>
	);
}

/* ── Main Page ──────────────────────────────────────────────────────────── */

export function WorkingCapitalPage() {
	const [refreshKey, setRefreshKey] = useState(0);
	const { data, error, isLoading } = useWcOverview(refreshKey);
	const kpi = data?.message;

	const handleRefreshed = useCallback(() => setRefreshKey((k) => k + 1), []);

	if (error) {
		return (
			<div className="card">
				<div className="card-title">Error</div>
				<p className="text-[13px] text-red">{error.message ?? "Failed to load"}</p>
			</div>
		);
	}

	return (
		<div>
			<PreparedReportHeader
				refreshedAt={kpi?.refreshed_at}
				section="wc"
				onRefreshed={handleRefreshed}
			/>
			{/* ── KPI Cards ── */}
			<SectionHeader
				color="var(--blue)"
				title="Capital Overview"
				tag={kpi ? `Live · ${kpi.as_of}` : "Loading…"}
			/>
			{isLoading || !kpi ? (
				<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="kpi animate-pulse">
							<div className="h-3 bg-surface-2 rounded w-2/3 mb-3" />
							<div className="h-6 bg-surface-2 rounded w-1/2" />
						</div>
					))}
				</div>
			) : (
				<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5">
					<KpiCard
						label="Net Working Capital"
						value={fmtCr(kpi.kpi.net_working_capital)}
						color="var(--blue)"
						icon="💼"
					/>
					<KpiCard
						label="Bank Balance"
						value={fmtCr(kpi.kpi.bank_balance)}
						color="var(--green)"
						icon="🏦"
						footer={
							<span className="text-[10.5px] text-text-3">
								{kpi.bank_account_count} accounts
							</span>
						}
					/>
					<KpiCard
						label="Trade Receivable"
						value={fmtCr(kpi.kpi.trade_receivable)}
						color="var(--blue)"
						icon="📥"
						footer={
							<Pill variant="info">DSO {fmtDays(kpi.kpi.dso)}</Pill>
						}
					/>
					<KpiCard
						label="Trade Payable"
						value={fmtCr(kpi.kpi.trade_payable)}
						color="var(--red)"
						icon="📤"
						footer={
							<Pill variant="warn">DPO {fmtDays(kpi.kpi.dpo)}</Pill>
						}
					/>
					<KpiCard
						label="Stock in Hand"
						value={fmtCr(kpi.kpi.stock_in_hand)}
						color="var(--purple)"
						icon="📦"
						footer={
							<Pill variant="info">DIO {fmtDays(kpi.kpi.dio)}</Pill>
						}
					/>
					<KpiCard
						label="Cash Conversion Cycle"
						value={fmtDays(kpi.kpi.ccc)}
						color="var(--teal)"
						icon="🔄"
						footer={
							<span className="text-[10px] text-text-3 font-mono">
								DSO + DIO − DPO
							</span>
						}
					/>
				</div>
			)}

			{/* ── Section Details ── */}
			<BankSection refreshKey={refreshKey} />
			<ReceivableSection refreshKey={refreshKey} />
			<PayableSection refreshKey={refreshKey} />
			<StockSection refreshKey={refreshKey} />
		</div>
	);
}
