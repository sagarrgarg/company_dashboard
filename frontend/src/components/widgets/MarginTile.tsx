import { cn, formatINRShort, formatPct } from "@/lib/utils";

interface Row {
	label: string;
	gpPct: number;
	gp: number;
	coverage: number;
}

const rowAccent = (pct: number) =>
	pct > 4 ? "text-green" : pct > 0 ? "text-amber" : "text-red";

/** Horizontal breakdown card: Overall · B2C · B2B as three side-by-side columns.
 *  Meant to sit on its own row (col-span full-width) so its height doesn't stretch
 *  adjacent simple KPIs. */
export function MarginTile({
	overall,
	b2c,
	b2b,
}: {
	overall: Row;
	b2c: Row;
	b2b: Row;
}) {
	const rows = [overall, b2c, b2b];
	return (
		<div className="card !p-0 overflow-hidden">
			<div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-border">
				<div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
					Gross Margin Breakdown · tax-excl
				</div>
				<div className="text-[9px] tracking-[0.1em] uppercase text-text-3 font-medium">
					{Math.round(overall.coverage)}% valuated
				</div>
			</div>
			<div className="grid grid-cols-3 divide-x divide-border">
				{rows.map((r) => (
					<div key={r.label} className="px-5 py-3.5 flex flex-col gap-1">
						<div className="text-[10.5px] font-semibold tracking-[0.08em] uppercase text-text-3">
							{r.label}
						</div>
						<div
							className={cn(
								"text-[22px] font-semibold tabular-nums leading-none tracking-tight",
								rowAccent(r.gpPct),
							)}
						>
							{formatPct(r.gpPct)}
						</div>
						<div className="text-[11px] text-text-2 tabular-nums font-medium">
							GP {formatINRShort(r.gp)}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
