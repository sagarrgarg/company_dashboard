import { useCallback, useEffect, useState } from "react";
import {
	useWcOverview,
	useBankDetail,
	useTradeReceivable,
	useTradePayable,
	useStockDetail,
} from "@/hooks/useWc";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { formatDays, formatINR, formatNumber, formatPct, shortDate } from "@/lib/utils";
import type {
	AgingBucket,
	AgingData,
	BankAccount,
	BankAccountKind,
	BankTrendPoint,
	PartyRow,
	ReorderAlert,
	StockGroup,
	WarehouseTreeNode,
} from "@/types/wc";

/* ── Shared sub-components ──────────────────────────────────────────────── */

const signColor = (v: number, pos = "var(--green)") => (v < 0 ? "var(--red)" : pos);

function SectionHeader({ color, title, tag }: { color: string; title: string; tag: string }) {
	return (
		<div className="flex items-center gap-3 mb-4 mt-10 first:mt-0">
			<span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
			<span className="font-semibold text-[15px] tracking-tight" style={{ color }}>
				{title}
			</span>
			<span className="flex-1 h-px bg-border" />
			<span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">{tag}</span>
		</div>
	);
}

/** Share-of-total bar for all-positive sets (ageing buckets). */
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
	const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(pct, 100)) : 0;
	return (
		<div className="grid grid-cols-[1fr_100px_36px_84px] items-center gap-2 mb-2">
			<span className="text-[12.5px] font-medium truncate">{label}</span>
			<div className="h-[7px] bg-surface-2 rounded-full overflow-hidden border border-border">
				<div
					className="h-full rounded-full transition-all duration-700"
					style={{ width: `${clamped}%`, background: color }}
				/>
			</div>
			<span className="text-[10px] font-mono text-text-3 text-right">{formatPct(pct, 0)}</span>
			<span className="text-[12px] font-mono font-semibold text-right" style={{ color }}>
				{valueStr}
			</span>
		</div>
	);
}

/** Bar scaled to absolute values with a zero line — negatives extend left in red. */
function SignedBar({
	label,
	tag,
	value,
	maxPos,
	maxNeg,
	posColor = "var(--green-mid)",
	title,
}: {
	label: string;
	tag?: React.ReactNode;
	value: number;
	maxPos: number;
	maxNeg: number;
	posColor?: string;
	title?: string;
}) {
	const span = maxPos + maxNeg || 1;
	const zero = (maxNeg / span) * 100;
	const w = (Math.abs(value) / span) * 100;
	const left = value >= 0 ? zero : zero - w;
	const color = value < 0 ? "var(--red)" : posColor;
	return (
		<div className="grid grid-cols-[1fr_120px_96px] items-center gap-2 mb-2" title={title}>
			<span className="text-[12.5px] font-medium truncate flex items-center gap-1.5 min-w-0">
				<span className="truncate">{label}</span>
				{tag}
			</span>
			<div className="relative h-[7px] bg-surface-2 rounded-full border border-border">
				<div
					className="absolute top-0 bottom-0 rounded-full transition-all duration-700"
					style={{ left: `${left}%`, width: `${Math.max(w, value !== 0 ? 1 : 0)}%`, background: color }}
				/>
				{maxNeg > 0 && (
					<div className="absolute -top-[3px] -bottom-[3px] w-px bg-text-3" style={{ left: `${zero}%` }} />
				)}
			</div>
			<span className="text-[12px] font-mono font-semibold text-right" style={{ color }}>
				{formatINR(value)}
			</span>
		</div>
	);
}

function scaleOf(values: number[]): { maxPos: number; maxNeg: number } {
	return {
		maxPos: Math.max(0, ...values),
		maxNeg: Math.max(0, ...values.map((v) => -v)),
	};
}

function StatBox({
	label,
	value,
	color,
	bg,
	title,
}: {
	label: string;
	value: string;
	color: string;
	bg: string;
	title?: string;
}) {
	return (
		<div className="rounded-[10px] py-3 px-4 text-center" style={{ background: bg }} title={title}>
			<div className="text-[9.5px] font-semibold tracking-[0.08em] uppercase mb-1 font-mono" style={{ color }}>
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
	title,
}: {
	children: React.ReactNode;
	variant: "up" | "down" | "warn" | "info" | "soft";
	title?: string;
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
			title={title}
			className={`inline-flex items-center gap-1 text-[10.5px] font-semibold font-mono px-2 py-[2px] rounded-[5px] whitespace-nowrap ${styles[variant]}`}
		>
			{children}
		</span>
	);
}

/** Line in a "how this total is made" list. */
function Line({
	label,
	value,
	strong,
	note,
	color,
}: {
	label: string;
	value: number | null | undefined;
	strong?: boolean;
	note?: string;
	color?: string;
}) {
	return (
		<div className={`flex justify-between gap-3 py-[3px] text-[12px] ${strong ? "font-semibold border-t border-border mt-1 pt-1.5" : ""}`}>
			<span className="text-text-2">
				{label}
				{note && <span className="text-text-4 text-[10.5px] ml-1">{note}</span>}
			</span>
			<span
				className="font-mono tabular-nums"
				style={{ color: color ?? (value != null && value < 0 ? "var(--red)" : "var(--text)") }}
			>
				{formatINR(value)}
			</span>
		</div>
	);
}

function DaysPill({ label, days, variant }: { label: string; days: number | null; variant: "info" | "warn" }) {
	return (
		<Pill variant={days == null ? "soft" : variant} title={days == null ? "Not meaningful for this data" : undefined}>
			{label} {formatDays(days)}
		</Pill>
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
			<div className="absolute top-0 left-0 right-0 h-[3px] rounded-t-[12px]" style={{ background: color }} />
			<div
				className="w-9 h-9 rounded-[10px] flex items-center justify-center text-[18px] mb-3"
				style={{ background: "var(--surface2)" }}
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

/* ── Bank / cash ────────────────────────────────────────────────────────── */

const KIND_LABEL: Record<BankAccountKind, string> = {
	bank: "Bank",
	cash: "Cash",
	gateway: "Gateway",
	borrowing: "OD / CC",
};
const KIND_ORDER: BankAccountKind[] = ["bank", "cash", "gateway", "borrowing"];

function BankSection({ company, refreshKey }: { company: string; refreshKey: number }) {
	const { data, isLoading, error } = useBankDetail(company, refreshKey);
	const d = data?.message;
	if (error) return <ErrorCard title="Cash & bank failed to load" error={error} />;
	if (isLoading || !d) return <LoadingCard />;
	const accounts = [...d.accounts].sort(
		(a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.balance - a.balance,
	);
	const scale = scaleOf(accounts.map((a) => a.balance));
	const netOfOd = d.cash_and_bank + d.borrowings;

	return (
		<>
			<SectionHeader
				color="var(--green)"
				title="Cash & Bank — Account-wise Breakup"
				tag={`GL · ${d.account_count} accounts · as of ${shortDate(d.as_of)}`}
			/>
			<div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3.5">
				<div className="card">
					<div className="flex justify-between items-start mb-4">
						<div>
							<div className="card-title !mb-0">Account-wise balance</div>
							<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">
								Bars scaled to absolute balance · zero line marks overdrawn accounts
							</div>
						</div>
						<div className="text-right">
							<div className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">
								Cash &amp; bank
							</div>
							<div className="text-[26px] font-bold tracking-tight" style={{ color: signColor(d.cash_and_bank) }}>
								{formatINR(d.cash_and_bank)}
							</div>
						</div>
					</div>
					{accounts.map((a: BankAccount) => (
						<SignedBar
							key={a.account}
							label={a.account.replace(/ - [^-]+$/, "")}
							tag={
								<Pill variant={a.kind === "borrowing" ? "down" : a.kind === "gateway" ? "warn" : "soft"}>
									{KIND_LABEL[a.kind]}
								</Pill>
							}
							value={a.balance}
							{...scale}
							title={`${a.account}${a.last_posting_date ? ` · last entry ${a.last_posting_date}` : ""}`}
						/>
					))}
					{accounts.length === 0 && <div className="text-[12px] text-text-3">No bank or cash accounts.</div>}

					<div className="mt-3 rounded-lg bg-surface-2/60 px-3 py-2">
						<Line label="Bank accounts" value={d.bank_total} />
						<Line label="Cash in hand" value={d.cash_total} />
						<Line label="Cash & bank" value={d.cash_and_bank} strong />
						<Line
							label="Overdraft / CC drawn"
							note="borrowing, not cash"
							value={d.borrowings}
							color={d.borrowings < 0 ? "var(--red)" : undefined}
						/>
						<Line label="Cash & bank net of OD / CC" value={netOfOd} strong />
						<Line label="Gateway receivables" note="settlements due, not cash" value={d.gateway_receivables} />
					</div>

					<hr className="border-border my-3" />
					<div className="grid grid-cols-3 gap-2.5">
						<StatBox
							label={d.net_inflow ? "Net cash flow / mo" : "Cash burn / mo"}
							value={d.net_inflow ? "Net inflow" : formatINR(d.cash_burn_monthly)}
							color={d.net_inflow ? "var(--green)" : "var(--amber)"}
							bg={d.net_inflow ? "var(--green-bg)" : "var(--amber-bg)"}
						/>
						<StatBox
							label="Days cash on hand"
							value={formatDays(d.days_cash_on_hand)}
							color="var(--blue)"
							bg="var(--blue-bg)"
							title={
								d.days_cash_on_hand == null
									? "Not meaningful: no net burn, or cash & bank is zero or negative"
									: undefined
							}
						/>
						<StatBox
							label="Net of OD / CC"
							value={formatINR(netOfOd)}
							color={netOfOd < 0 ? "var(--red)" : "var(--purple)"}
							bg={netOfOd < 0 ? "var(--red-bg)" : "var(--purple-bg)"}
						/>
					</div>
				</div>
				<div className="card">
					<div className="card-title !mb-0">Cash &amp; bank trend</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
						Month-opening balance · last point today
					</div>
					<BankTrendSvg trend={d.trend} />
				</div>
			</div>
		</>
	);
}

function BankTrendSvg({ trend }: { trend: BankTrendPoint[] }) {
	if (!trend.length) return <div className="text-[12px] text-text-3">No history.</div>;
	const w = 240;
	const h = 130;
	const padTop = 16;
	const padBot = 22;
	const padX = 20;
	const usableH = h - padTop - padBot;
	// Domain includes every point and zero, so an overdrawn month can't plot off the chart.
	const maxBal = Math.max(0, ...trend.map((t) => t.balance));
	const minBal = Math.min(0, ...trend.map((t) => t.balance));
	const range = maxBal - minBal || 1;
	const y = (v: number) => padTop + ((maxBal - v) / range) * usableH;
	const step = (w - 2 * padX) / Math.max(trend.length - 1, 1);
	const pts = trend.map((t, i) => ({ x: padX + i * step, y: y(t.balance), ...t }));
	const zeroY = y(0);
	const polyline = pts.map((p) => `${p.x},${p.y}`).join(" ");
	const polygon = `${polyline} ${pts[pts.length - 1].x},${zeroY} ${pts[0].x},${zeroY}`;
	const last = pts[pts.length - 1];

	return (
		<svg viewBox={`0 0 ${w} ${h + 6}`} className="w-full">
			<defs>
				<linearGradient id="bankGrad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stopColor="var(--green-mid)" stopOpacity="0.25" />
					<stop offset="100%" stopColor="var(--green-mid)" stopOpacity="0" />
				</linearGradient>
			</defs>
			<line x1={0} x2={w} y1={zeroY} y2={zeroY} stroke="rgba(40,30,15,.35)" strokeWidth={0.75} />
			<text x={w} y={zeroY - 3} textAnchor="end" style={{ fontSize: 7, fill: "#7A6F5D", fontFamily: "monospace" }}>
				₹0
			</text>
			<polygon points={polygon} fill="url(#bankGrad)" />
			<polyline
				points={polyline}
				fill="none"
				stroke="var(--green-mid)"
				strokeWidth="2.25"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			{pts.map((p) => (
				<g key={p.date}>
					<title>{`${p.is_today ? "Today" : `${p.month} ${p.year} opening`}: ${formatINR(p.balance)}`}</title>
					<circle
						cx={p.x}
						cy={p.y}
						r={p.is_today ? 4.5 : 3}
						fill={p.balance < 0 ? "var(--red)" : "var(--green-mid)"}
						stroke="white"
						strokeWidth={p.is_today ? 2 : 1.5}
					/>
					<text
						x={p.x}
						y={h - 4}
						textAnchor="middle"
						className="fill-text-3"
						style={{ fontSize: 7.5, fontFamily: "monospace", fontWeight: p.is_today ? 700 : 400 }}
					>
						{p.is_today ? "TODAY" : `${p.month.toUpperCase()} '${String(p.year).slice(-2)}`}
					</text>
				</g>
			))}
			<text
				x={Math.min(last.x, w - 4)}
				y={Math.max(last.y - 8, 8)}
				textAnchor="end"
				style={{ fontSize: 8, fontWeight: 700, fill: last.balance < 0 ? "var(--red)" : "var(--green)" }}
			>
				{formatINR(last.balance)}
			</text>
		</svg>
	);
}

/* ── Receivable / payable ───────────────────────────────────────────────── */

const AGING_COLORS = ["var(--green-mid)", "var(--amber)", "var(--red)", "#991B1B", "#991B1B"];

function AgingCard({
	title,
	subtitle,
	aging,
	color,
	children,
}: {
	title: string;
	subtitle: string;
	aging: AgingData;
	color: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="card">
			<div className="flex justify-between items-start mb-4">
				<div>
					<div className="card-title !mb-0">{title}</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">{subtitle}</div>
				</div>
				<div className="text-right">
					<div className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">Gross outstanding</div>
					<div className="text-[22px] font-bold tracking-tight" style={{ color }}>
						{formatINR(aging.total_outstanding)}
					</div>
				</div>
			</div>
			{aging.buckets.map((b: AgingBucket, i: number) =>
				b.reconciling ? (
					<div
						key={b.label}
						className="grid grid-cols-[1fr_84px] items-center gap-2 mb-2 italic text-text-3"
						title="Not an age bucket: the part of the GL gross the BNS ageing report doesn't cover"
					>
						<span className="text-[12px] truncate">{b.label}</span>
						<span
							className="text-[12px] font-mono text-right"
							style={{ color: b.amount < 0 ? "var(--red)" : undefined }}
						>
							{formatINR(b.amount)}
						</span>
					</div>
				) : (
					<ProgressBar
						key={b.label}
						label={b.label}
						pct={b.pct}
						color={AGING_COLORS[i] ?? "var(--green-mid)"}
						valueStr={formatINR(b.amount)}
					/>
				),
			)}
			<div className="text-[10px] text-text-3 mt-1">
				Ageing from the BNS FIFO summary ({formatINR(aging.bns_total)})
				{aging.buckets.some((b) => b.reconciling) ? "; the reconciling line brings it to the GL gross." : "."}
			</div>
			{aging.warning && (
				<div className="text-[10.5px] text-amber mt-1" role="note">
					⚠ {aging.warning}
				</div>
			)}
			{children}
		</div>
	);
}

function ReceivableSection({ company, refreshKey }: { company: string; refreshKey: number }) {
	const { data, isLoading, error } = useTradeReceivable(company, refreshKey);
	const d = data?.message;
	if (error) return <ErrorCard title="Trade receivable failed to load" error={error} />;
	if (isLoading || !d) return <LoadingCard />;
	const ce = d.collection_efficiency;

	return (
		<>
			<SectionHeader color="var(--blue)" title="Trade Receivable — Detailed Breakup" tag="GL balances · FIFO ageing" />
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
				<AgingCard title="Receivable ageing" subtitle="Days since due date · gross" aging={d.aging} color="var(--blue)">
					<div className="mt-3 rounded-lg bg-surface-2/60 px-3 py-2">
						<Line label="Gross receivable (debit balances)" value={d.gross} />
						<Line label="Customer advances" note="net-credit customers" value={d.advances} />
						<Line label="Net trade receivable (GL)" value={d.total} strong />
					</div>
					<hr className="border-border my-3" />
					<div className="grid grid-cols-2 gap-2.5">
						<StatBox
							label="Total overdue"
							value={formatINR(d.aging.total_overdue)}
							color="var(--red)"
							bg="var(--red-bg)"
						/>
						<StatBox
							label="DSO"
							value={formatDays(d.dso)}
							color="var(--blue)"
							bg="var(--blue-bg)"
							title={`Net receivable ÷ net credit sales of the last 365 days (${formatINR(d.net_credit_sales_365d)}) × 365`}
						/>
					</div>
					<ReconcilingNote internal={d.internal_accounts_total} excluded={d.excluded_parties_total} side="debtor" />
				</AgingCard>
				<div className="card">
					<div className="card-title !mb-0">Top debtors by outstanding</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
						Customer-wise · sorted by amount
					</div>
					<PartyTable rows={d.top_debtors} groupField="customer_group" />
					<hr className="border-border my-3" />
					<div className="flex justify-between items-center gap-3">
						<span className="text-[12px] font-medium text-text-3">
							Collection efficiency — MTD
							<span className="block text-[10px] font-normal text-text-4">
								collections {formatINR(d.collections_mtd)} ÷ (opening {formatINR(d.opening_receivable)} +
								billing {formatINR(d.billing_mtd)})
							</span>
						</span>
						<div className="flex items-center gap-2.5 shrink-0">
							<div className="w-[100px] h-[7px] bg-surface-2 rounded-full overflow-hidden border border-border">
								<div
									className="h-full bg-green-mid rounded-full"
									style={{ width: `${ce == null ? 0 : Math.max(0, Math.min(ce, 100))}%` }}
								/>
							</div>
							<Pill variant={ce == null ? "soft" : "up"}>{ce == null ? "n/a" : formatPct(ce, 0)}</Pill>
						</div>
					</div>
				</div>
			</div>
		</>
	);
}

function PayableSection({ company, refreshKey }: { company: string; refreshKey: number }) {
	const { data, isLoading, error } = useTradePayable(company, refreshKey);
	const d = data?.message;
	if (error) return <ErrorCard title="Trade payable failed to load" error={error} />;
	if (isLoading || !d) return <LoadingCard />;

	return (
		<>
			<SectionHeader color="var(--red)" title="Trade Payable — Detailed Breakup" tag="GL balances · FIFO ageing" />
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
				<AgingCard title="Payable ageing" subtitle="Current vs overdue · gross" aging={d.aging} color="var(--red)">
					<div className="mt-3 rounded-lg bg-surface-2/60 px-3 py-2">
						<Line label="Gross payable (credit balances)" value={d.gross} />
						<Line label="Supplier advances" note="net-debit suppliers" value={d.advances} />
						<Line label="Net trade payable (GL)" value={d.total} strong />
					</div>
					<hr className="border-border my-3" />
					<div className="grid grid-cols-3 gap-2.5">
						<StatBox
							label="Total overdue"
							value={formatINR(d.aging.total_overdue)}
							color="var(--red)"
							bg="var(--red-bg)"
						/>
						<StatBox
							label="DPO"
							value={formatDays(d.dpo)}
							color="var(--purple)"
							bg="var(--purple-bg)"
							title={`Net payable ÷ external purchases of the last 365 days (${formatINR(d.net_purchases_365d)}) × 365`}
						/>
						<StatBox
							label="Advance paid"
							value={formatINR(d.advance_paid)}
							color="var(--blue)"
							bg="var(--blue-bg)"
							title="Suppliers with a net debit balance (= − supplier advances)"
						/>
					</div>
					<ReconcilingNote internal={d.internal_accounts_total} excluded={d.excluded_parties_total} side="creditor" />
				</AgingCard>
				<div className="card">
					<div className="card-title !mb-0">Supplier-wise payable</div>
					<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
						Sorted by outstanding
					</div>
					<PartyTable rows={d.top_creditors} groupField="supplier_group" />
				</div>
			</div>
		</>
	);
}

function ReconcilingNote({
	internal,
	excluded,
	side,
}: {
	internal: number;
	excluded: number;
	side: "debtor" | "creditor";
}) {
	if (!internal && !excluded) return null;
	return (
		<div className="text-[10.5px] text-text-3 mt-3 leading-relaxed">
			<span className="font-semibold text-text-2">Reconciling items, excluded above:</span> internal {side}{" "}
			accounts {formatINR(internal)}
			{excluded ? <> · excluded internal parties {formatINR(excluded)}</> : null}.
		</div>
	);
}

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
						{["Party", "Group", "Outstanding", "Age", "Status"].map((h, i) => (
							<th
								key={h}
								className={`${i < 2 ? "text-left" : "text-right"} py-1.5 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider text-text-3`}
							>
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.party} className="border-b border-border hover:bg-surface-2/50">
							<td className="py-2 px-2 font-medium truncate max-w-[180px]" title={r.party}>
								{r.party_name || r.party}
							</td>
							<td className="py-2 px-2">
								<Pill variant="soft" title={r[groupField] ?? undefined}>
									{(r[groupField] || "—").slice(0, 14)}
								</Pill>
							</td>
							<td className="py-2 px-2 text-right font-mono font-semibold">{formatINR(r.outstanding)}</td>
							<td className="py-2 px-2 text-right font-mono text-text-3">
								{r.age_days == null ? "—" : `${formatNumber(r.age_days)}d`}
							</td>
							<td className="py-2 px-2 text-right">{statusPill(r.status)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/* ── Stock in hand ──────────────────────────────────────────────────────── */

function whLabel(name: string): string {
	return name.replace(/ - [^-]+$/, "").replace(/_/g, " ");
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
	const pct = total > 0 ? (node.stock_value / total) * 100 : null;

	return (
		<>
			<div
				className={`flex items-center py-[5px] border-b border-border/40 hover:bg-surface-2/40 ${node.is_group ? "cursor-pointer" : ""}`}
				style={{ paddingLeft: depth * 20 + 4 }}
				onClick={node.is_group ? () => onToggle(node.name) : undefined}
			>
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
				<span
					className={`flex-1 min-w-0 text-[12px] leading-tight ${node.is_group ? "font-semibold text-text" : "text-text-2"}`}
					title={node.name}
				>
					{whLabel(node.name)}
					<span className="text-[9.5px] text-text-4 ml-1.5">{formatNumber(node.sku_count)} SKUs</span>
				</span>
				<span className="text-[9px] font-mono text-text-3 tabular-nums w-[36px] text-right shrink-0 mr-2">
					{pct == null ? "" : pct >= 1 ? formatPct(pct, 0) : pct > 0 ? "<1%" : pct < 0 ? formatPct(pct, 0) : ""}
				</span>
				<span
					className={`text-[11.5px] font-mono tabular-nums text-right shrink-0 w-[84px] ${node.is_group ? "font-semibold" : "font-medium"}`}
					style={{ color: node.stock_value < 0 ? "var(--red)" : node.is_group ? "var(--purple)" : "var(--text2)" }}
				>
					{formatINR(node.stock_value)}
				</span>
			</div>
			{node.is_group &&
				isOpen &&
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

function StockSection({ company, refreshKey }: { company: string; refreshKey: number }) {
	const { data, isLoading, error } = useStockDetail(company, refreshKey);
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

	if (error) return <ErrorCard title="Stock failed to load" error={error} />;
	if (isLoading || !d) return <LoadingCard />;

	const groupColors = ["var(--blue)", "var(--green-mid)", "var(--purple)", "var(--amber)", "var(--teal)"];
	const groupScale = scaleOf(d.by_item_group.map((g) => g.stock_value));
	const gap = d.bin_vs_gl_gap;

	return (
		<>
			<SectionHeader
				color="var(--purple)"
				title="Stock in Hand — Warehouse & Category Breakup"
				tag={`GL total · bins for breakdown · ${d.warehouse_count} warehouses`}
			/>
			<div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3.5">
				<div className="card">
					<div className="flex justify-between items-start mb-3">
						<div>
							<div className="card-title !mb-0">By warehouse</div>
							<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5">
								Bin values · click groups to expand · {d.warehouse_count} locations
							</div>
						</div>
						<div className="text-right">
							<div className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">
								Stock in hand (GL)
							</div>
							<div className="text-[22px] font-bold tracking-tight text-purple">{formatINR(d.stock_in_hand)}</div>
						</div>
					</div>
					<div className="max-h-[500px] overflow-y-auto -mx-1 px-1">
						{d.warehouse_tree.map((node: WarehouseTreeNode) => (
							<WarehouseTreeRow
								key={node.name}
								node={node}
								total={d.bin_total}
								depth={0}
								expanded={expanded}
								onToggle={onToggle}
							/>
						))}
					</div>
					<div className="mt-3 rounded-lg bg-surface-2/60 px-3 py-2">
						<Line
							label="Stock in hand (GL)"
							note={d.stock_accounts.join(", ")}
							value={d.stock_in_hand}
							color="var(--purple)"
						/>
						<Line label="Bin total (stock ledger)" value={d.bin_total} />
						<Line
							label="Bin vs GL gap"
							value={gap}
							color={Math.abs(gap) >= 1 ? "var(--amber)" : undefined}
							strong
						/>
						{d.negative_bins.count > 0 && (
							<div className="text-[10.5px] text-red mt-1">
								{formatNumber(d.negative_bins.count)} negative bin{d.negative_bins.count === 1 ? "" : "s"} (
								{formatINR(d.negative_bins.value)}) are included in the breakdowns — fix the stock postings
								behind them.
							</div>
						)}
						{d.zero_qty_valued_bins.count > 0 && (
							<div className="text-[10.5px] text-amber mt-1">
								{formatNumber(d.zero_qty_valued_bins.count)} bin
								{d.zero_qty_valued_bins.count === 1 ? "" : "s"} with zero quantity still carry{" "}
								{formatINR(d.zero_qty_valued_bins.value)} of value.
							</div>
						)}
					</div>
					<hr className="border-border my-3" />
					<div className="grid grid-cols-2 gap-2.5">
						<StatBox
							label="DIO"
							value={formatDays(d.dio)}
							color="var(--amber)"
							bg="var(--amber-bg)"
							title={`GL stock ÷ GL cost of goods of the last 365 days (${formatINR(d.cogs_365d)}) × 365`}
						/>
						<StatBox
							label="SKUs below min"
							value={formatNumber(d.reorder_count)}
							color="var(--red)"
							bg="var(--red-bg)"
						/>
					</div>
				</div>

				<div className="flex flex-col gap-3.5">
					<div className="card">
						<div className="card-title !mb-0">By item category</div>
						<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
							Bin value by item group
						</div>
						{d.by_item_group.map((g: StockGroup, i: number) => (
							<SignedBar
								key={g.item_group}
								label={g.item_group}
								value={g.stock_value}
								{...groupScale}
								posColor={groupColors[i % groupColors.length]}
								title={`${g.item_group}: ${formatNumber(g.sku_count)} SKUs`}
							/>
						))}
					</div>

					<div className="card">
						<div className="card-title !mb-0">Reorder alerts</div>
						<div className="text-[10px] font-mono text-text-3 uppercase tracking-wider mt-0.5 mb-3">
							{d.reorder_alerts.length < d.reorder_count
								? `Top ${d.reorder_alerts.length} of ${formatNumber(d.reorder_count)} below reorder level / safety stock`
								: `${formatNumber(d.reorder_count)} below reorder level / safety stock`}
						</div>
						{d.reorder_alerts.length === 0 ? (
							<div className="text-[12px] text-text-3">All items above their reorder level</div>
						) : (
							d.reorder_alerts.map((r: ReorderAlert) => {
								const pct = Math.max(0, Math.min(r.pct, 100));
								const color = r.pct < 30 ? "var(--red)" : "var(--amber)";
								return (
									<div
										key={`${r.item_code}-${r.warehouse ?? ""}`}
										className="grid grid-cols-[1fr_80px_84px] items-center gap-2 mb-2"
										title={`${r.rule === "reorder_level" ? "Reorder level" : "Safety stock"} ${formatNumber(r.safety_stock)} ${r.stock_uom}${r.projected_qty != null ? ` · projected ${formatNumber(r.projected_qty)}` : ""}`}
									>
										<span className="text-[12px] font-medium truncate min-w-0">
											{r.item_name || r.item_code}
											{r.warehouse && (
												<span className="block text-[9.5px] text-text-4 truncate">{whLabel(r.warehouse)}</span>
											)}
										</span>
										<div className="h-[7px] bg-surface-2 rounded-full overflow-hidden border border-border">
											<div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
										</div>
										<span className="text-[12px] font-mono font-semibold text-right" style={{ color }}>
											{formatNumber(r.actual_qty)} {r.stock_uom}
										</span>
									</div>
								);
							})
						)}
					</div>
				</div>
			</div>
		</>
	);
}

/* ── Loading ────────────────────────────────────────────────────────────── */

function LoadingCard() {
	return (
		<div className="card animate-pulse mt-6">
			<div className="h-4 bg-surface-2 rounded w-1/3 mb-3" />
			<div className="h-8 bg-surface-2 rounded w-1/2 mb-4" />
			<div className="h-3 bg-surface-2 rounded w-full mb-2" />
			<div className="h-3 bg-surface-2 rounded w-2/3" />
		</div>
	);
}

/* ── Main page ──────────────────────────────────────────────────────────── */

export function WorkingCapitalPage({
	company,
	refreshKey,
	onRefreshed,
	onLoaded,
}: {
	company: string;
	/** Lives in App so navigating away doesn't undo a refresh. */
	refreshKey: number;
	onRefreshed: () => void;
	onLoaded?: (company: string) => void;
}) {
	const { data, error, isLoading } = useWcOverview(company, refreshKey);
	const ov = data?.message;
	const k = ov?.kpi;

	useEffect(() => {
		if (ov && onLoaded) onLoaded(ov.company);
	}, [ov, onLoaded]);

	return (
		<div>
			<PreparedReportHeader
				refreshedAt={ov?.refreshed_at}
				stale={ov?.stale}
				section="wc"
				onRefreshed={onRefreshed}
			/>
			<SectionHeader
				color="var(--blue)"
				title="Capital Overview"
				tag={ov ? `GL snapshot · as of ${shortDate(ov.as_of)}` : isLoading ? "Loading…" : ""}
			/>
			{error ? (
				<ErrorCard title="Working capital failed to load" error={error} />
			) : isLoading || !k ? (
				<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="kpi animate-pulse">
							<div className="h-3 bg-surface-2 rounded w-2/3 mb-3" />
							<div className="h-6 bg-surface-2 rounded w-1/2" />
						</div>
					))}
				</div>
			) : (
				<>
					<div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3.5">
						<KpiCard
							label="Trade working capital"
							value={formatINR(k.trade_working_capital)}
							color={signColor(k.trade_working_capital, "var(--blue)")}
							icon="💼"
							footer={<span className="text-[10px] text-text-3 font-mono">AR + stock − AP</span>}
						/>
						<KpiCard
							label="Cash & bank"
							value={formatINR(k.cash_and_bank)}
							color={signColor(k.cash_and_bank)}
							icon="🏦"
							footer={
								<>
									{k.borrowings !== 0 && (
										<Pill variant="down" title="Overdraft / cash-credit drawn — a borrowing, not cash">
											OD / CC {formatINR(k.borrowings)}
										</Pill>
									)}
									{k.gateway_receivables !== 0 && (
										<Pill variant="warn" title="Payment-gateway settlements due — a receivable, not cash">
											Gateway {formatINR(k.gateway_receivables)}
										</Pill>
									)}
									<span className="text-[10.5px] text-text-3">{ov?.bank_account_count} accounts</span>
								</>
							}
						/>
						<KpiCard
							label="Trade receivable (net)"
							value={formatINR(k.trade_receivable)}
							color="var(--blue)"
							icon="📥"
							footer={
								<>
									<DaysPill label="DSO" days={k.dso} variant="info" />
									<span className="text-[10px] text-text-3">adv. {formatINR(k.customer_advances)}</span>
								</>
							}
						/>
						<KpiCard
							label="Trade payable (net)"
							value={formatINR(k.trade_payable)}
							color="var(--red)"
							icon="📤"
							footer={
								<>
									<DaysPill label="DPO" days={k.dpo} variant="warn" />
									<span className="text-[10px] text-text-3">adv. {formatINR(k.supplier_advances)}</span>
								</>
							}
						/>
						<KpiCard
							label="Stock in hand (GL)"
							value={formatINR(k.stock_in_hand)}
							color="var(--purple)"
							icon="📦"
							footer={<DaysPill label="DIO" days={k.dio} variant="info" />}
						/>
						<KpiCard
							label="Cash conversion cycle"
							value={formatDays(k.ccc, true)}
							color="var(--teal)"
							icon="🔄"
							footer={<span className="text-[10px] text-text-3 font-mono">DSO + DIO − DPO</span>}
						/>
					</div>

					<div className="card mt-3.5 !py-3.5">
						<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
							<WcDefinition
								label="Trade working capital"
								formula="Receivable (net) + stock − payable (net)"
								value={k.trade_working_capital}
							/>
							<WcDefinition
								label="Working capital incl. cash"
								formula="Trade WC + cash & bank"
								value={k.working_capital_with_cash}
							/>
							<WcDefinition
								label="Working capital net of OD / CC"
								formula="Trade WC + cash & bank − OD/CC drawn"
								value={k.working_capital_net_of_borrowings}
							/>
						</div>
						<div className="text-[10.5px] text-text-3 mt-3 pt-2.5 border-t border-border leading-relaxed">
							<span className="font-semibold text-text-2">Reconciling items, excluded:</span> internal
							(sister-company) receivable {formatINR(k.internal_receivable)} and internal payable{" "}
							{formatINR(k.internal_payable)}. Gross receivable {formatINR(k.receivable_gross)} plus customer
							advances {formatINR(k.customer_advances)} = net; gross payable {formatINR(k.payable_gross)} plus
							supplier advances {formatINR(k.supplier_advances)} = net.
						</div>
					</div>
				</>
			)}

			<BankSection company={company} refreshKey={refreshKey} />
			<ReceivableSection company={company} refreshKey={refreshKey} />
			<PayableSection company={company} refreshKey={refreshKey} />
			<StockSection company={company} refreshKey={refreshKey} />
		</div>
	);
}

function WcDefinition({ label, formula, value }: { label: string; formula: string; value: number }) {
	return (
		<div>
			<div className="text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3">{label}</div>
			<div className="text-[20px] font-semibold tabular-nums tracking-tight" style={{ color: signColor(value, "var(--text)") }}>
				{formatINR(value)}
			</div>
			<div className="text-[10.5px] text-text-3 font-mono">{formula}</div>
		</div>
	);
}
