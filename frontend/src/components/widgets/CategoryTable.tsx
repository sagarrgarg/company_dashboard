import { cn, formatINRShort, formatPct } from "@/lib/utils";
import type { CategorySlice } from "@/types/mis";

/** Top-N categories ranked by revenue with an inline mini-bar so the eye can scan
 *  contribution at a glance without needing a separate chart card. Revenue is in
 *  ₹ lakhs (matches the API). Total row at the bottom. */
export function CategoryTable({ data }: { data: CategorySlice[] }) {
	const total = data.reduce((sum, d) => sum + d.revenue, 0) || 1;
	const max = Math.max(...data.map((d) => d.revenue), 0);

	return (
		<div className="overflow-x-auto -mx-1">
			<table className="w-full text-[11.5px] tabular-nums">
				<thead>
					<tr className="border-b border-border">
						<th className="px-1.5 py-1.5 text-left text-[9.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
							Category
						</th>
						<th className="px-1.5 py-1.5 text-right text-[9.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
							Revenue
						</th>
						<th className="px-1.5 py-1.5 text-right text-[9.5px] font-semibold tracking-[0.08em] uppercase text-text-3 w-[58px]">
							%
						</th>
					</tr>
				</thead>
				<tbody>
					{data.map((row) => {
						const share = (row.revenue / total) * 100;
						const widthPct = max ? (row.revenue / max) * 100 : 0;
						return (
							<tr
								key={row.category}
								className="border-b border-border last:border-b-0 hover:bg-surface-2/60"
							>
								<td className="px-1.5 py-1.5 text-text-2">
									<div className="flex items-center gap-2">
										<span className="truncate max-w-[140px]" title={row.category}>
											{row.category}
										</span>
										<span className="text-[9.5px] text-text-4 font-medium">
											{row.sku_count}
										</span>
									</div>
								</td>
								<td className="px-1.5 py-1.5 text-right relative">
									<div
										className="absolute inset-y-1 right-1 left-1 rounded-sm bg-green/[0.08] pointer-events-none"
										style={{
											clipPath: `inset(0 ${100 - widthPct}% 0 0)`,
										}}
										aria-hidden
									/>
									<span className="relative font-medium text-text">
										{formatINRShort(row.revenue * 100000)}
									</span>
								</td>
								<td
									className={cn(
										"px-1.5 py-1.5 text-right tabular-nums",
										share >= 10 ? "font-semibold text-text" : "text-text-3",
									)}
								>
									{formatPct(share)}
								</td>
							</tr>
						);
					})}
					<tr className="bg-surface-2 font-semibold">
						<td className="px-1.5 py-2 text-text">
							Total{" "}
							<span className="text-[9.5px] text-text-3 font-medium ml-1">
								{data.reduce((s, d) => s + d.sku_count, 0)} SKUs
							</span>
						</td>
						<td className="px-1.5 py-2 text-right text-text">
							{formatINRShort(total * 100000)}
						</td>
						<td className="px-1.5 py-2 text-right text-text-2">100%</td>
					</tr>
				</tbody>
			</table>
		</div>
	);
}
