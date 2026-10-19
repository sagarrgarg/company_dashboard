import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	LabelList,
	ReferenceLine,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { PnlStep } from "@/lib/pnl";
import { formatINR, formatMargin, formatPct, marginState } from "@/lib/utils";

interface Row {
	key: string;
	label: string;
	/** Plotted value — null for hidden / not-meaningful tiers, so no bar is drawn. */
	plot: number | null;
	pct: number | null;
	amount: number;
	/** Text above the bar. */
	tag: string;
	hidden: boolean;
	amountHidden: boolean;
}

const COLORS = {
	positive: "#1F5F33",
	negative: "#7A1F1F",
} as const;

const AXIS = { fontSize: 10, fill: "#7A6F5D", fontWeight: 500 } as const;

/** Tier-only ladder shown as % of ex-tax revenue (API `pct`). Tiers with an impossible
 *  margin (|pct| > 100) or a hidden ("Coming soon") value get no bar, so one bogus value
 *  can't blow up the axis. */
export function PnlWaterfallChart({ steps }: { steps: PnlStep[] }) {
	const rows: Row[] = steps
		.filter((s) => s.kind === "tier")
		.map((s) => {
			const ok = !s.hidden && marginState(s.pct) === "ok";
			return {
				key: s.key,
				label: shortLabel(s.label),
				plot: ok ? s.pct : null,
				pct: s.pct,
				amount: s.subtotal,
				tag: s.hidden ? "soon" : formatMargin(s.pct),
				hidden: s.hidden,
				amountHidden: s.amountHidden,
			};
		});

	const plotted = rows.map((r) => r.plot).filter((v): v is number => v != null);
	const minPct = Math.min(0, ...plotted);
	const maxPct = Math.max(0, ...plotted);
	const pad = Math.max(2, (maxPct - minPct) * 0.12);
	// Round the domain to a tidy step so ticks land on round percentages.
	const range = maxPct - minPct;
	const tick = range > 100 ? 25 : range > 40 ? 10 : 5;
	const lo = minPct < 0 ? Math.floor((minPct - pad) / tick) * tick : 0;
	const hi = Math.ceil((maxPct + pad) / tick) * tick || tick;
	// Hidden / n/a tiers still need a slot for their label at the zero line.
	const data = rows.map((r) => ({ ...r, bar: r.plot ?? 0 }));

	return (
		<ResponsiveContainer width="100%" height={320}>
			<BarChart data={data} margin={{ top: 28, right: 16, left: 4, bottom: 16 }} barCategoryGap="22%">
				<CartesianGrid stroke="rgba(40,30,15,.07)" vertical={false} />
				<XAxis
					dataKey="label"
					tickLine={false}
					axisLine={false}
					tick={{ ...AXIS, fontWeight: 600 }}
					interval={0}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tick={AXIS}
					tickFormatter={(v) => formatPct(Number(v), 0)}
					domain={[lo, hi]}
					ticks={Array.from({ length: Math.round((hi - lo) / tick) + 1 }, (_, i) => lo + i * tick)}
					width={48}
				/>
				<ReferenceLine y={0} stroke="rgba(40,30,15,.35)" strokeWidth={1} />
				<Tooltip cursor={{ fill: "rgba(40,30,15,.04)" }} content={<TierTooltip />} />
				<Bar dataKey="bar" radius={[4, 4, 0, 0]} isAnimationActive={false}>
					{data.map((r) => (
						<Cell
							key={r.key}
							fill={r.plot == null ? "transparent" : r.plot >= 0 ? COLORS.positive : COLORS.negative}
						/>
					))}
					<LabelList
						dataKey="tag"
						position="top"
						style={{ fontSize: 11, fill: "#1a1810", fontWeight: 600 }}
					/>
				</Bar>
			</BarChart>
		</ResponsiveContainer>
	);
}

function TierTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: Array<{ payload: Row }>;
}) {
	if (!active || !payload?.length) return null;
	const row = payload[0].payload;
	const st = marginState(row.pct);
	return (
		<div
			style={{
				background: "#fff",
				border: "1px solid rgba(40,30,15,.18)",
				borderRadius: 10,
				boxShadow: "0 4px 16px rgba(40,30,15,.08)",
				padding: "10px 14px",
				fontSize: 12,
				minWidth: 200,
				maxWidth: 280,
			}}
		>
			<div style={{ fontWeight: 600, color: "#1a1810", marginBottom: 6 }}>{row.label}</div>
			{row.hidden ? (
				<div style={{ color: "#96560F", fontWeight: 600 }}>Coming soon</div>
			) : (
				<>
					<div
						style={{
							color: st !== "ok" ? "#96560F" : (row.pct ?? 0) >= 0 ? "#1F5F33" : "#7A1F1F",
							fontWeight: 600,
						}}
					>
						{st === "ok" ? `${formatPct(row.pct)} of ex-tax revenue` : formatMargin(row.pct)}
					</div>
					{st === "bogus" && (
						<div style={{ color: "#574f3e", fontSize: 11, marginTop: 2 }}>
							Computed {formatPct(row.pct)} — beyond ±100%, almost always a stock-valuation error.
						</div>
					)}
					{st === "na" && (
						<div style={{ color: "#574f3e", fontSize: 11, marginTop: 2 }}>
							Revenue below ₹1,000 — % not meaningful.
						</div>
					)}
					{!row.amountHidden && (
						<div style={{ color: "#574f3e", fontSize: 11, marginTop: 2 }}>{formatINR(row.amount)}</div>
					)}
				</>
			)}
		</div>
	);
}

/** "CM1 · Gross margin" → "CM1"; keep PBT/PAT/EBIT/EBITDA short. */
function shortLabel(label: string): string {
	return label.split("·")[0]?.trim() ?? label;
}
