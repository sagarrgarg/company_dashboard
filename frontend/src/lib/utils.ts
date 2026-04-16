import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Format absolute INR amount as lakhs (₹NL) or crores (₹NCr). */
export function formatINRShort(value: number): string {
	if (value == null || Number.isNaN(value)) return "—";
	const abs = Math.abs(value);
	if (abs >= 1_00_00_000) return `₹${(value / 1_00_00_000).toFixed(1)}Cr`;
	if (abs >= 1_00_000) return `₹${Math.round(value / 1_00_000)}L`;
	if (abs >= 1_000) return `₹${(value / 1_000).toFixed(1)}K`;
	return `₹${Math.round(value)}`;
}

export function formatPct(value: number, digits = 1): string {
	if (value == null || Number.isNaN(value)) return "—";
	return `${value.toFixed(digits)}%`;
}

export function formatDelta(value: number | null | undefined): {
	label: string;
	direction: "up" | "down" | "flat";
} {
	if (value == null || Number.isNaN(value)) return { label: "—", direction: "flat" };
	if (value > 0) return { label: `↑${value.toFixed(0)}%`, direction: "up" };
	if (value < 0) return { label: `↓${Math.abs(value).toFixed(0)}%`, direction: "down" };
	return { label: "0%", direction: "flat" };
}
