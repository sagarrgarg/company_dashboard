import {
	Area,
	CartesianGrid,
	ComposedChart,
	Legend,
	Line,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { MonthlyRevenuePoint } from "@/types/mis";
import { formatINR, monthLabel } from "@/lib/utils";
import { splitPartial, TOOLTIP_STYLE } from "@/lib/chart";

const AXIS = { fontSize: 10, fill: "#7A6F5D", fontWeight: 500 } as const;
const GRID_STROKE = "rgba(40,30,15,.08)";
const LAKH = 1_00_000;

interface Series {
	key: "b2c" | "b2b" | "other" | "total";
	name: string;
	color: string;
	width: number;
}

/** Monthly revenue (API values are ₹ lakhs). Month-to-date / partial months are dashed. */
export function RevenueTrendChart({
	data,
	hideUnclassified = false,
}: {
	data: MonthlyRevenuePoint[];
	hideUnclassified?: boolean;
}) {
	const series: Series[] = [
		{ key: "b2c", name: "B2C", color: "#1F5F33", width: 2.25 },
		{ key: "b2b", name: "B2B", color: "#96560F", width: 2.25 },
		...(hideUnclassified ? [] : [{ key: "other", name: "Unclassified", color: "#7A6F5D", width: 1.5 } as Series]),
		{ key: "total", name: "Total", color: "#1a1810", width: 1.2 },
	];
	const rows = splitPartial(
		data.map((d) => ({ ...d, label: monthLabel(d.key ?? `${d.year}-${d.month}`) })),
		series.map((s) => s.key),
		(r) => Boolean(r.partial),
	);
	const anyPartial = data.some((d) => d.partial);

	return (
		<>
			<ResponsiveContainer width="100%" height={260}>
				<ComposedChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
					<defs>
						<linearGradient id="b2cFill" x1="0" y1="0" x2="0" y2="1">
							<stop offset="0%" stopColor="#1F5F33" stopOpacity={0.28} />
							<stop offset="100%" stopColor="#1F5F33" stopOpacity={0} />
						</linearGradient>
					</defs>
					<CartesianGrid stroke={GRID_STROKE} vertical={false} />
					<XAxis dataKey="label" tickLine={false} axisLine={false} tick={AXIS} />
					<YAxis
						tickLine={false}
						axisLine={false}
						tick={AXIS}
						tickFormatter={(v) => formatINR(Number(v) * LAKH)}
						width={72}
					/>
					<Tooltip
						cursor={{ stroke: "rgba(40,30,15,.18)", strokeWidth: 1 }}
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const row = payload[0].payload as MonthlyRevenuePoint & { label: string };
							return (
								<div style={TOOLTIP_STYLE}>
									<div style={{ color: "#1a1810", fontWeight: 600, marginBottom: 4 }}>
										{row.label}
										{row.partial && (
											<span style={{ color: "#96560F", fontWeight: 500 }}> · partial month</span>
										)}
									</div>
									{series.map((s) => (
										<div key={s.key} style={{ color: s.color }}>
											{s.name}: {formatINR(row[s.key] * LAKH)}
										</div>
									))}
								</div>
							);
						}}
					/>
					<Legend
						verticalAlign="top"
						height={28}
						iconType="circle"
						iconSize={8}
						wrapperStyle={{ fontSize: 11, color: "#574f3e", fontWeight: 500 }}
						payload={series.map((s) => ({ value: s.name, type: "circle" as const, id: s.key, color: s.color }))}
					/>
					{series.map((s) =>
						s.key === "b2c" ? (
							<Area
								key={s.key}
								type="monotone"
								dataKey={`${s.key}__solid`}
								name={s.name}
								stroke={s.color}
								strokeWidth={s.width}
								fill="url(#b2cFill)"
								activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
								isAnimationActive={false}
							/>
						) : (
							<Line
								key={s.key}
								type="monotone"
								dataKey={`${s.key}__solid`}
								name={s.name}
								stroke={s.color}
								strokeWidth={s.width}
								strokeDasharray={s.key === "other" ? "2 3" : undefined}
								dot={false}
								activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
								isAnimationActive={false}
							/>
						),
					)}
					{series.map((s) => (
						<Line
							key={`${s.key}__mtd`}
							type="monotone"
							dataKey={`${s.key}__mtd`}
							name={`${s.name} (partial)`}
							legendType="none"
							stroke={s.color}
							strokeWidth={s.width}
							strokeDasharray="5 4"
							strokeOpacity={0.75}
							dot={(props: { cx?: number; cy?: number; index?: number }) => {
								const r = rows[props.index ?? -1];
								if (!r?.partial || props.cx == null || props.cy == null) return <g key={props.index} />;
								return (
									<circle
										key={props.index}
										cx={props.cx}
										cy={props.cy}
										r={3}
										fill="#fff"
										stroke={s.color}
										strokeWidth={1.5}
									/>
								);
							}}
							activeDot={false}
							isAnimationActive={false}
						/>
					))}
				</ComposedChart>
			</ResponsiveContainer>
			{anyPartial && (
				<div className="text-[10px] text-text-3 mt-1">
					Dashed segment = partial month (month to date or a range that starts mid-month).
				</div>
			)}
		</>
	);
}
