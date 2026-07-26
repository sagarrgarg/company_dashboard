import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatINRShort } from "@/lib/utils";

const COLORS = ["#1F5F33", "#96560F"];

export function RevenueMixChart({ b2c, b2b }: { b2c: number; b2b: number }) {
	const data = [
		{ name: "B2C", value: b2c },
		{ name: "B2B", value: b2b },
	];
	const total = b2c + b2b || 1;
	return (
		<>
			<div className="flex flex-wrap gap-x-3.5 gap-y-2 mb-2.5">
				{data.map((d, i) => (
					<div key={d.name} className="flex items-center gap-[5px] text-[11px] text-text-2">
						<div className="w-2.5 h-2.5 rounded-sm" style={{ background: COLORS[i] }} />
						{d.name} · {Math.round((d.value / total) * 100)}%
					</div>
				))}
			</div>
			<ResponsiveContainer width="100%" height={140}>
				<PieChart>
					<Pie
						data={data}
						cx="50%"
						cy="50%"
						innerRadius={40}
						outerRadius={60}
						paddingAngle={2}
						dataKey="value"
						stroke="none"
					>
						{data.map((_, i) => (
							<Cell key={i} fill={COLORS[i]} />
						))}
					</Pie>
					<Tooltip
						formatter={(v: number) => formatINRShort(v)}
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
