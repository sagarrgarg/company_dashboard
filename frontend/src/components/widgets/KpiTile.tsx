import { cn, PRIOR_INCOMPLETE, type Delta } from "@/lib/utils";
import { Explain } from "@/components/explain/Explain";
import type { ExplainContent } from "@/lib/explain";

export type KpiAccent = "default" | "green" | "amber" | "red" | "blue";

export interface KpiTileProps {
	label: string;
	value: string;
	/** Tooltip on the value (e.g. why a margin reads "n/a ⚠"). */
	valueTitle?: string;
	meta?: React.ReactNode;
	accent?: KpiAccent;
	delta?: Delta;
	/** Basis of this tile's figure, e.g. "incl. tax" or "ex-tax". */
	basis?: string;
	comingSoon?: boolean;
	/** Breakdown shown on hover / tap of the value. */
	explain?: ExplainContent;
}

const ACCENT: Record<KpiAccent, string> = {
	default: "text-text",
	green: "text-green",
	amber: "text-amber",
	red: "text-red",
	blue: "text-blue",
};

const CHG: Record<"up" | "down" | "flat", string> = {
	up: "bg-green-bg text-green",
	down: "bg-red-bg text-red",
	flat: "bg-surface-3 text-text-3",
};

export function KpiTile({
	label,
	value,
	valueTitle,
	meta,
	accent = "default",
	delta,
	basis,
	comingSoon = false,
	explain,
}: KpiTileProps) {
	const labelRow = (
		<div className="kpi-lbl flex items-baseline justify-between gap-2">
			<span>{label}</span>
			{basis && (
				<span className="text-[8.5px] tracking-[0.08em] uppercase text-text-4 font-semibold whitespace-nowrap">
					{basis}
				</span>
			)}
		</div>
	);

	if (comingSoon) {
		return (
			<div
				className="kpi relative overflow-hidden bg-surface-2/60"
				aria-label={`${label} — coming soon`}
				aria-disabled="true"
				title="Coming soon — admin can enable in Company Dashboard Settings"
			>
				<div className="text-text-3">{labelRow}</div>
				<div className="kpi-val text-text-4 select-none">—</div>
				<div className="kpi-meta text-text-4 select-none">Not available yet</div>
				<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
					<span className="badge bg-amber-bg text-amber font-semibold tracking-wide uppercase text-[10px] shadow-sm">
						Coming soon
					</span>
				</div>
			</div>
		);
	}

	return (
		<div className="kpi">
			{labelRow}
			{explain ? (
				<div className={cn("kpi-val", ACCENT[accent])}>
					<Explain
						content={valueTitle ? { ...explain, notes: [valueTitle, ...(explain.notes ?? [])] } : explain}
						label={`${label}, ${value}${explain.valueSub ? `, ${explain.value} ${explain.valueSub}` : `, ${explain.value}`}, has breakdown`}
					>
						{value}
					</Explain>
				</div>
			) : (
				<div className={cn("kpi-val", ACCENT[accent])} title={valueTitle}>
					{value}
				</div>
			)}
			<div className="kpi-meta flex-wrap">
				{delta &&
					(delta.unavailable ? (
						<span
							className={cn("chg", CHG.flat)}
							title="The prior period isn't fully covered by data, so growth isn't comparable."
						>
							{PRIOR_INCOMPLETE}
						</span>
					) : (
						<span className={cn("chg", CHG[delta.direction])}>{delta.label}</span>
					))}
				{meta}
			</div>
		</div>
	);
}
