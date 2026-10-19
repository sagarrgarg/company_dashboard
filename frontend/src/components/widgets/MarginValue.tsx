import { cn, formatMargin, marginState, marginTitle } from "@/lib/utils";

/** A margin % cell: the value, "n/a" (revenue below the floor) or "n/a ⚠" (impossible
 *  margin, with a tooltip). `colorFor` picks the class for real values. */
export function MarginValue({
	pct,
	digits = 1,
	colorFor,
	className,
}: {
	pct: number | null | undefined;
	digits?: number;
	colorFor?: (pct: number) => string;
	className?: string;
}) {
	const st = marginState(pct);
	return (
		<span
			title={marginTitle(pct)}
			className={cn(
				st === "na" && "text-text-4 font-normal",
				st === "bogus" && "text-amber font-semibold cursor-help",
				st === "ok" && colorFor && pct != null && colorFor(pct),
				className,
			)}
		>
			{formatMargin(pct, digits)}
		</span>
	);
}

/** Placeholder for a figure hidden by a "Coming soon" flag. */
export function SoonValue({ className }: { className?: string }) {
	return (
		<span
			className={cn("text-[10px] font-semibold uppercase tracking-wide text-amber", className)}
			title="Coming soon — admin can enable in Company Dashboard Settings"
		>
			soon
		</span>
	);
}
