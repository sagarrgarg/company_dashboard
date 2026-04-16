import { cn, formatINRShort, formatPct } from "@/lib/utils";
import type { PnlStep } from "@/lib/pnl";

/** Sample.html's `.plt` treatment: sub-lines indented in grey, tier rows bolded
 *  with a shaded background, numbers right-aligned. Percentages are % of Gross
 *  Revenue (stays consistent even as the waterfall goes negative). */
export function PnlTable({ steps }: { steps: PnlStep[] }) {
	const revenue = steps[0]?.subtotal ?? 0;
	return (
		<div className="card !p-0 overflow-hidden">
			<div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-border">
				<div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
					P&amp;L — line by line
				</div>
				<div className="text-[9px] tracking-[0.1em] uppercase text-text-3 font-medium">
					tax-excl · ₹
				</div>
			</div>
			<table className="w-full text-[12px] tabular-nums">
				<thead>
					<tr>
						<Th className="text-left">Line item</Th>
						<Th>₹ amount</Th>
						<Th>% Revenue</Th>
						<Th>Detail</Th>
					</tr>
				</thead>
				<tbody>
					{steps.map((step) => {
						const isTier = step.kind === "tier" || step.kind === "anchor";
						const pct = revenue ? (step.subtotal / revenue) * 100 : 0;
						const pctDed = revenue ? (step.amount / revenue) * 100 : 0;
						return (
							<tr
								key={step.key}
								className={cn(
									"border-b border-border last:border-b-0",
									isTier && "bg-surface-2 font-semibold",
								)}
							>
								<td
									className={cn(
										"px-5 py-2",
										step.indent === 1 && "pl-10 text-text-3",
										isTier && "text-text",
									)}
								>
									{step.label}
								</td>
								<td
									className={cn(
										"px-3 py-2 text-right",
										step.kind === "deduction" ? "text-amber" : "text-text",
										isTier && step.subtotal < 0 && "text-red",
										isTier && step.subtotal >= 0 && "text-text",
									)}
								>
									{formatINRShort(isTier ? step.subtotal : step.amount)}
								</td>
								<td
									className={cn(
										"px-3 py-2 text-right",
										isTier
											? step.subtotal >= 0
												? "text-text-2"
												: "text-red"
											: "text-text-3",
									)}
								>
									{isTier ? formatPct(pct) : formatPct(pctDed)}
								</td>
								<td className="px-5 py-2 text-right text-[10.5px] text-text-3">
									{step.note ?? ""}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<th
			className={cn(
				"px-3 py-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 border-b border-border",
				!className && "text-right",
				className,
			)}
		>
			{children}
		</th>
	);
}
