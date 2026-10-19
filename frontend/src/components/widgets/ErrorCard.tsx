import { errorMessage } from "@/lib/utils";
import type { PeriodSelection } from "@/types/mis";

/** Error state that keeps the user unstuck: the real server message, plus a one-click
 *  reset to the default period (the page header with its controls stays above it). */
export function ErrorCard({
	title,
	error,
	period,
	onPeriodChange,
	hint,
}: {
	title: string;
	error: unknown;
	period?: PeriodSelection;
	onPeriodChange?: (next: PeriodSelection) => void;
	hint?: React.ReactNode;
}) {
	return (
		<div className="card" role="alert">
			<div className="card-title text-red">{title}</div>
			<p className="text-[12px] text-text-2 whitespace-pre-wrap break-words">{errorMessage(error)}</p>
			{hint && <p className="text-[12px] text-text-3 mt-3">{hint}</p>}
			{period && onPeriodChange && period.kind !== "ttm" && (
				<button
					type="button"
					onClick={() => onPeriodChange({ kind: "ttm" })}
					className="mt-3 px-3 py-1.5 text-[11.5px] font-semibold rounded-full bg-green text-white hover:bg-green-mid"
				>
					Reset to last 12 months
				</button>
			)}
		</div>
	);
}
