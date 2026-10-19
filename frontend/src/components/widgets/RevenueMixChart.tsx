import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatINR } from "@/lib/utils";

export interface MixSlice {
	name: string;
	value: number;
	/** Share of total revenue, rounded — the same number the KPI tiles show. */
	share: number | null;
	color: string;
	/** Hidden by a "Coming soon" flag. */
	hidden?: boolean;
}

/** Donut of the revenue split. Shares come from the caller (one shared computation, so the
 *  donut and the tiles never disagree). Negative slices (net returns) can't be drawn and
 *  are listed in the legend only. */
export function RevenueMixChart({ slices }: { slices: MixSlice[] }) {
	const drawable = slices.filter((s) => !s.hidden && s.value > 0);
	return (
		<>
			<div className="flex flex-wrap gap-x-3.5 gap-y-2 mb-2.5">
				{slices.map((d) => (
					<div key={d.name} className="flex items-center gap-[5px] text-[11px] text-text-2">
						<div className="w-2.5 h-2.5 rounded-sm" style={{ background: d.color }} />
						{d.name} ·{" "}
						{d.hidden ? (
							<span className="text-amber font-semibold uppercase text-[10px]">soon</span>
						) : d.share == null ? (
							"—"
						) : (
							`${d.share}%`
						)}
						{!d.hidden && d.value < 0 && <span className="text-text-3">(net returns)</span>}
					</div>
				))}
			</div>
			<ResponsiveContainer width="100%" height={140}>
				<PieChart>
					<Pie
						data={drawable}
						cx="50%"
						cy="50%"
						innerRadius={40}
						outerRadius={60}
						paddingAngle={2}
						dataKey="value"
						stroke="none"
						isAnimationActive={false}
					>
						{drawable.map((d) => (
							<Cell key={d.name} fill={d.color} />
						))}
					</Pie>
					<Tooltip
						formatter={(v: number) => formatINR(v)}
						contentStyle={{
							background: "#fff",
							border: "1px solid rgba(40,30,15,.18)",
							borderRadius: 10,
							fontSize: 12,
							padding: "8px 12px",
							boxShadow: "0 4px 16px rgba(40,30,15,.08)",
						}}
					/>
				</PieChart>
			</ResponsiveContainer>
		</>
	);
}
