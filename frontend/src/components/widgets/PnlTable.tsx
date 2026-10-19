import { cn, formatINR, formatMargin, marginState, marginTitle } from "@/lib/utils";
import type { PnlStep } from "@/lib/pnl";
import { MarginValue, SoonValue } from "@/components/widgets/MarginValue";
import { Explain } from "@/components/explain/Explain";
import { explainStep, lineHref, type ExplainCtx } from "@/lib/explain";

/** Sample.html's `.plt` treatment: sub-lines indented in grey, tier rows bolded with a
 *  shaded background, numbers right-aligned. Every line comes from the API ladder; all
 *  amounts and % are on tax-exclusive revenue. */
export function PnlTable({ steps, ctx }: { steps: PnlStep[]; ctx: ExplainCtx }) {
	return (
		<div className="card !p-0 overflow-hidden">
			<div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-border">
				<div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
					P&amp;L — line by line
				</div>
				<div className="text-[9px] tracking-[0.1em] uppercase text-text-3 font-medium">
					ex-tax · ₹ · % of ex-tax revenue
				</div>
			</div>
			<div className="overflow-x-auto">
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
						const value = isTier ? step.subtotal : step.amount;
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
									{step.hidden ? (
										step.label
									) : (
										<a
											href={lineHref(ctx, step.key, ctx.bucket)}
											target="_blank"
											rel="noopener"
											className="hover:text-green hover:underline underline-offset-2"
										>
											{step.label}
											<span className="sr-only"> (opens breakdown in a new tab)</span>
										</a>
									)}
								</td>
								<td
									className={cn(
										"px-3 py-2 text-right whitespace-nowrap",
										step.kind === "deduction" ? "text-amber" : "text-text",
										isTier && step.subtotal < 0 && "text-red",
									)}
								>
									{step.hidden || step.amountHidden ? (
										<SoonValue />
									) : (
										<Explain content={() => explainStep(step, ctx)} label={`${step.label}, ${formatINR(value)}, ${formatMargin(step.pct)} of revenue, has breakdown`}>
											{formatINR(value)}
										</Explain>
									)}
								</td>
								<td className="px-3 py-2 text-right whitespace-nowrap">
									{step.hidden ? (
										<SoonValue />
									) : isTier ? (
										<MarginValue
											pct={step.pct}
											colorFor={(p) => (p >= 0 ? "text-text-2" : "text-red")}
										/>
									) : (
										<span
											className={cn(
												"text-text-3",
												marginState(step.pct) === "bogus" && "text-amber font-semibold cursor-help",
											)}
											title={marginTitle(step.pct)}
										>
											{formatMargin(step.pct)}
										</span>
									)}
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
