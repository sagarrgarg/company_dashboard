import { cn, formatINR, formatPct, marginState } from "@/lib/utils";
import { MarginValue, SoonValue } from "@/components/widgets/MarginValue";

export interface MarginRow {
	label: string;
	gpPct: number | null;
	gp: number;
	coverage: number | null;
	/** Whole column hidden by a "Coming soon" flag. */
	hidden?: boolean;
}

const rowAccent = (pct: number) => (pct > 4 ? "text-green" : pct > 0 ? "text-amber" : "text-red");

/** Horizontal breakdown card: Overall · B2C · B2B · Unclassified, so the split adds up
 *  to the total. All figures are ex-tax. */
export function MarginTile({ rows, hideGp = false }: { rows: MarginRow[]; hideGp?: boolean }) {
	const overall = rows[0];
	return (
		<div className="card !p-0 overflow-hidden">
			<div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-border">
				<div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
					Gross Margin Breakdown · ex-tax
				</div>
				<div className="text-[9px] tracking-[0.1em] uppercase text-text-3 font-medium">
					{overall?.coverage != null ? `${formatPct(overall.coverage, 0)} cost-valuated` : ""}
				</div>
			</div>
			<div
				className="grid divide-x divide-border"
				style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}
			>
				{rows.map((r) => (
					<div key={r.label} className="px-5 py-3.5 flex flex-col gap-1">
						<div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
							{r.label}
						</div>
						{r.hidden ? (
							<SoonValue className="text-[12px] py-1" />
						) : (
							<>
								<div
									className={cn(
										"text-[22px] font-semibold tabular-nums leading-none tracking-tight",
										marginState(r.gpPct) !== "ok" && "text-[18px]",
									)}
								>
									<MarginValue pct={r.gpPct} colorFor={rowAccent} />
								</div>
								<div className="text-[11px] text-text-2 tabular-nums font-medium">
									GP {hideGp ? <SoonValue /> : formatINR(r.gp)}
								</div>
							</>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
