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

const AXIS = { fontSize: 10, fill: "#7A6F5D", fontWeight: 500 } as const;
const GRID_STROKE = "rgba(40,30,15,.08)";

export function RevenueTrendChart({ data }: { data: MonthlyRevenuePoint[] }) {
	return (
		<ResponsiveContainer width="100%" height={260}>
			<ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
				<defs>
					<linearGradient id="b2cFill" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stopColor="#1F5F33" stopOpacity={0.28} />
						<stop offset="100%" stopColor="#1F5F33" stopOpacity={0} />
					</linearGradient>
				</defs>
				<CartesianGrid stroke={GRID_STROKE} vertical={false} />
				<XAxis dataKey="month" tickLine={false} axisLine={false} tick={AXIS} />
				<YAxis
					tickLine={false}
					axisLine={false}
					tick={AXIS}
					tickFormatter={(v) => `₹${v}L`}
					width={44}
				/>
				<Tooltip
					cursor={{ stroke: "rgba(40,30,15,.18)", strokeWidth: 1 }}
					contentStyle={{
						background: "#ffffff",
						border: "1px solid rgba(40,30,15,.18)",
						borderRadius: 10,
						fontSize: 12,
						padding: "8px 12px",
						boxShadow: "0 4px 16px rgba(40,30,15,.08)",
					}}
					labelStyle={{ color: "#1a1810", fontWeight: 600, marginBottom: 4 }}
					formatter={(v: number, name) => [`₹${v.toFixed(1)}L`, name]}
				/>
				<Legend
					verticalAlign="top"
					height={28}
					iconType="circle"
					iconSize={8}
					wrapperStyle={{ fontSize: 11, color: "#574f3e", fontWeight: 500 }}
				/>
				<Area
					type="monotone"
					dataKey="b2c"
					name="B2C"
					stroke="#1F5F33"
					strokeWidth={2.25}
					fill="url(#b2cFill)"
					activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
				/>
				<Line
					type="monotone"
					dataKey="b2b"
					name="B2B"
					stroke="#96560F"
					strokeWidth={2.25}
					dot={false}
					activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
				/>
				<Line
					type="monotone"
					dataKey="other"
					name="Unclassified"
					stroke="#7A6F5D"
					strokeWidth={1.5}
					strokeDasharray="4 4"
					dot={false}
				/>
				<Line
					type="monotone"
					dataKey="total"
					name="Total"
					stroke="#1a1810"
					strokeWidth={1.2}
					dot={false}
				/>
			</ComposedChart>
		</ResponsiveContainer>
	);
}
