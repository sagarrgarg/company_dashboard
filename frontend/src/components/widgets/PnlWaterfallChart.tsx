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
import { formatINRShort, formatPct } from "@/lib/utils";

interface Row {
	key: string;
	label: string;
	pct: number;
	amount: number;
	kind: PnlStep["kind"];
}

const COLORS = {
	anchor: "#1a1810",
	positive: "#1F5F33",
	negative: "#7A1F1F",
} as const;

const AXIS = { fontSize: 10, fill: "#7A6F5D", fontWeight: 500 } as const;

/** Tier-only ladder shown as % of Revenue. Anchor (Gross Revenue, always 100%) and
 *  deduction lines stay in the P&L table — the chart focuses on the margin progression. */
export function PnlWaterfallChart({ steps }: { steps: PnlStep[] }) {
	const revenue = steps[0]?.subtotal ?? 0;
	const rows: Row[] = steps
		.filter((s) => s.kind === "tier")
		.map((s) => ({
			key: s.key,
			label: shortLabel(s.label),
			pct: revenue ? (s.subtotal / revenue) * 100 : 0,
			amount: s.subtotal,
			kind: s.kind,
		}));

	const minPct = Math.min(0, ...rows.map((r) => r.pct));
	const maxPct = Math.max(...rows.map((r) => r.pct));
	const pad = Math.max(2, (maxPct - minPct) * 0.12);

	return (
		<ResponsiveContainer width="100%" height={320}>
			<BarChart
				data={rows}
				margin={{ top: 28, right: 16, left: 4, bottom: 16 }}
				barCategoryGap="22%"
			>
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
					tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
					domain={[minPct - pad, maxPct + pad]}
					width={48}
				/>
				<ReferenceLine y={0} stroke="rgba(40,30,15,.35)" strokeWidth={1} />
				<Tooltip cursor={{ fill: "rgba(40,30,15,.04)" }} content={<TierTooltip />} />
				<Bar dataKey="pct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
					{rows.map((r) => (
						<Cell
							key={r.key}
							fill={
								r.kind === "anchor"
									? COLORS.anchor
									: r.pct >= 0
										? COLORS.positive
										: COLORS.negative
							}
						/>
					))}
					<LabelList
						dataKey="pct"
						position="top"
						formatter={(v: number) => formatPct(v)}
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
			}}
		>
			<div style={{ fontWeight: 600, color: "#1a1810", marginBottom: 6 }}>{row.label}</div>
			<div style={{ color: row.pct >= 0 ? "#1F5F33" : "#7A1F1F", fontWeight: 600 }}>
				{formatPct(row.pct)} of revenue
			</div>
			<div style={{ color: "#574f3e", fontSize: 11, marginTop: 2 }}>
				{formatINRShort(row.amount)}
			</div>
		</div>
	);
}

/** "CM1 · Gross Margin" → "CM1"; keep PBT/PAT/EBIT/EBITDA short. */
function shortLabel(label: string): string {
	const head = label.split("·")[0]?.trim() ?? label;
	return head;
}
