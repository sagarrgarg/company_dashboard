import { useState } from "react";
import { formatINR, formatNumber, formatPct, monthLabel } from "@/lib/utils";
import type { DataQuality } from "@/types/mis";

/** F1 — "Data issue: stock valuation" banner. Shown when the API flagged invoice lines
 *  with impossible cost, or when the page itself sees a margin beyond ±100% / cost above
 *  2× revenue. Also lists account-mapping warnings and any PAT ↔ GL residual. */
export function DataQualityBanner({
	dq,
	impossibleMargins = false,
	costOverRevenue = false,
}: {
	dq: DataQuality | undefined;
	impossibleMargins?: boolean;
	costOverRevenue?: boolean;
}) {
	const [open, setOpen] = useState(false);
	if (!dq) return null;
	const flagged = dq.flagged_lines > 0;
	const valuationIssue = flagged || impossibleMargins || costOverRevenue;
	const warnings = dq.warnings ?? [];
	const residual = dq.pat_residual != null && Math.abs(dq.pat_residual) >= 1 ? dq.pat_residual : null;
	if (!valuationIssue && warnings.length === 0 && residual == null) return null;

	return (
		<div className="mb-5 flex flex-col gap-2.5">
			{valuationIssue && (
				<div className="px-4 py-3 rounded-lg bg-red-bg border border-red/20 text-red text-[12px] leading-relaxed">
					<div className="flex items-start gap-2.5">
						<span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-red text-white text-[10px] font-bold flex items-center justify-center">
							!
						</span>
						<div className="flex-1 min-w-0">
							<strong className="font-semibold">Data issue: stock valuation. </strong>
							{flagged ? (
								<>
									{formatNumber(dq.flagged_lines)} invoice line{dq.flagged_lines === 1 ? "" : "s"} carry an
									impossible stock-ledger cost ({formatINR(dq.flagged_cost)} cost on{" "}
									{formatINR(dq.flagged_revenue)} revenue). They are kept out of the SKU, segment and
									B2C/B2B cost splits; company totals still come from the GL.{" "}
								</>
							) : null}
							{(impossibleMargins || costOverRevenue) && (
								<>
									Some figures show a margin beyond ±100% or cost above 2× revenue — those cells read{" "}
									<span className="font-semibold">n/a ⚠</span> instead of a number.{" "}
								</>
							)}
							<span className="text-red/80">
								Cost valuation covers {formatPct(dq.coverage_pct)} of revenue. Fix the valuation rate
								on the items below (Stock Ledger / Repost Item Valuation), then refresh.
							</span>
							{dq.anomalies.length > 0 && (
								<div className="mt-1.5">
									<button
										type="button"
										onClick={() => setOpen((x) => !x)}
										className="font-semibold underline underline-offset-2"
										aria-expanded={open}
									>
										{open ? "Hide" : "Show"} {dq.anomalies.length} flagged line
										{dq.anomalies.length === 1 ? "" : "s"}
									</button>
								</div>
							)}
						</div>
					</div>
					{open && dq.anomalies.length > 0 && (
						<div className="mt-3 max-h-[320px] overflow-auto rounded-md bg-surface border border-border text-text">
							<table className="w-full text-[11px] tabular-nums">
								<thead className="sticky top-0 bg-surface">
									<tr className="text-[9.5px] uppercase tracking-[0.06em] text-text-3">
										<th className="px-2 py-1.5 text-left">Invoice</th>
										<th className="px-2 py-1.5 text-left">Item</th>
										<th className="px-2 py-1.5 text-left">Customer</th>
										<th className="px-2 py-1.5 text-left">Month</th>
										<th className="px-2 py-1.5 text-right">Qty</th>
										<th className="px-2 py-1.5 text-right">Revenue</th>
										<th className="px-2 py-1.5 text-right">Cost</th>
										<th className="px-2 py-1.5 text-right">Unit cost</th>
									</tr>
								</thead>
								<tbody>
									{dq.anomalies.map((a, i) => (
										<tr key={`${a.invoice}-${a.item_code}-${i}`} className="border-t border-border">
											<td className="px-2 py-1 font-mono">
												<a
													href={`/app/sales-invoice/${encodeURIComponent(a.invoice)}`}
													target="_blank"
													rel="noreferrer"
													className="text-green hover:underline"
												>
													{a.invoice}
												</a>
											</td>
											<td className="px-2 py-1">
												<span className="font-semibold">{a.item_code}</span>{" "}
												<span className="text-text-3">{a.item_name}</span>
											</td>
											<td className="px-2 py-1 text-text-2">{a.customer}</td>
											<td className="px-2 py-1 text-text-2">{monthLabel(a.month)}</td>
											<td className="px-2 py-1 text-right">{formatNumber(a.qty, 2)}</td>
											<td className="px-2 py-1 text-right">{formatINR(a.revenue)}</td>
											<td className="px-2 py-1 text-right text-red font-semibold">{formatINR(a.cost)}</td>
											<td className="px-2 py-1 text-right">{formatINR(a.unit_cost)}</td>
										</tr>
									))}
								</tbody>
							</table>
							<div className="px-2 py-1.5 text-[10px] text-text-3 border-t border-border">
								Flagged when cost ≥ {formatINR(dq.rules.min_cost)} and cost is more than{" "}
								{dq.rules.cost_to_revenue}× revenue, or the unit cost is more than{" "}
								{dq.rules.unit_cost_to_median}× the item's median.
							</div>
						</div>
					)}
				</div>
			)}

			{(warnings.length > 0 || residual != null) && (
				<div className="px-4 py-3 rounded-lg bg-amber-bg border border-amber/20 text-amber text-[12px] leading-relaxed flex items-start gap-2.5">
					<span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-amber text-white text-[10px] font-bold flex items-center justify-center">
						!
					</span>
					<div className="min-w-0">
						<strong className="font-semibold">Account mapping: </strong>
						<ul className="list-disc pl-4 mt-0.5">
							{warnings.map((w, i) => (
								<li key={`${w.code}-${i}`}>
									{w.message}
									{w.account && <span className="font-mono text-[11px]"> · {w.account}</span>}
								</li>
							))}
							{residual != null && (
								<li>PAT differs from GL net profit by {formatINR(residual)}.</li>
							)}
						</ul>
					</div>
				</div>
			)}
		</div>
	);
}
