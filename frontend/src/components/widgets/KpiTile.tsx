import { cn } from "@/lib/utils";

export type KpiAccent = "default" | "green" | "amber" | "red" | "blue";

export interface KpiTileProps {
	label: string;
	value: string;
	meta?: React.ReactNode;
	accent?: KpiAccent;
	delta?: { label: string; direction: "up" | "down" | "flat" };
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

export function KpiTile({ label, value, meta, accent = "default", delta }: KpiTileProps) {
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
