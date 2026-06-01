import { cn } from "@/lib/utils";

export type KpiAccent = "default" | "green" | "amber" | "red" | "blue";

export interface KpiTileProps {
	label: string;
	value: string;
	meta?: React.ReactNode;
	accent?: KpiAccent;
	delta?: { label: string; direction: "up" | "down" | "flat" };
	comingSoon?: boolean;
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
	meta,
	accent = "default",
	delta,
	comingSoon = false,
}: KpiTileProps) {
	if (comingSoon) {
		return (
			<div
				className="kpi relative overflow-hidden bg-surface-2/60"
				aria-label={`${label} — coming soon`}
				aria-disabled="true"
				title="Coming soon — admin can enable in Company Dashboard Settings"
			>
				<div className="kpi-lbl text-text-3">{label}</div>
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
			<div className="kpi-lbl">{label}</div>
			<div className={cn("kpi-val", ACCENT[accent])}>{value}</div>
			<div className="kpi-meta">
				{delta && <span className={cn("chg", CHG[delta.direction])}>{delta.label}</span>}
				{meta}
			</div>
		</div>
	);
}
