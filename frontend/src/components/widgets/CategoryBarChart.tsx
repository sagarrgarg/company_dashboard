import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import type { CategorySlice } from "@/types/mis";

/** Colour-blind-safe palette tuned for AA contrast on white surface. */
const CAT_COLORS: Record<string, string> = {
	Cashews: "#1F5F33",
	Makhana: "#2C4E80",
	"Gift Packs": "#96560F",
	Gifts: "#96560F",
	Almonds: "#4A2F7A",
	Raisins: "#7A1F1F",
	Pistachios: "#1D5E51",
	"Mixed Nuts": "#574F3E",
	Snacks: "#7A6F5D",
	"Flavoured Nuts": "#B2621C",
	"Dehydrated Fruits": "#3B6D82",
	Combo: "#5B3E76",
	Walnuts: "#5C3417",
	"Breakfast Mixes": "#3D6B4C",
	Seeds: "#8E5A1E",
};
const FALLBACK = [
	"#1F5F33",
	"#2C4E80",
	"#96560F",
	"#4A2F7A",
	"#7A1F1F",
	"#1D5E51",
	"#574F3E",
	"#B2621C",
	"#3B6D82",
	"#5B3E76",
	"#5C3417",
];

export function CategoryBarChart({ data }: { data: CategorySlice[] }) {
	return (
		<ResponsiveContainer width="100%" height={140}>
			<BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
				<CartesianGrid stroke="rgba(40,30,15,.08)" vertical={false} />
				<XAxis
					dataKey="category"
					tickLine={false}
					axisLine={false}
					tick={{ fontSize: 10, fill: "#7A6F5D", fontWeight: 500 }}
					interval={0}
				/>
				<YAxis
					tickLine={false}
					axisLine={false}
					tick={{ fontSize: 10, fill: "#7A6F5D", fontWeight: 500 }}
					width={28}
				/>
				<Tooltip
					cursor={{ fill: "rgba(40,30,15,.05)" }}
					contentStyle={{
						background: "#fff",
						border: "1px solid rgba(40,30,15,.18)",
						borderRadius: 10,
						fontSize: 12,
						padding: "8px 12px",
						boxShadow: "0 4px 16px rgba(40,30,15,.08)",
					}}
					formatter={(v: number) => [`${v} SKUs`, "Count"]}
				/>
				<Bar dataKey="sku_count" radius={[4, 4, 0, 0]}>
					{data.map((d, i) => (
						<Cell
							key={d.category}
							fill={CAT_COLORS[d.category] ?? FALLBACK[i % FALLBACK.length]}
						/>
					))}
				</Bar>
			</BarChart>
		</ResponsiveContainer>
	);
}
