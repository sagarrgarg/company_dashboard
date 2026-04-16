import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useFiscalYears } from "@/hooks/useOverview";
import type { FiscalYear, PeriodSelection } from "@/types/mis";

interface Props {
	value: PeriodSelection;
	onChange: (next: PeriodSelection) => void;
}

/** Top-right period control: Trailing 12M · Fiscal Year · Custom from-to.
 *  Click the pill to open a small popover with all three options; selection
 *  bubbles up via ``onChange`` and is labeled inline so users can see what's
 *  currently in effect without opening the popover. */
export function PeriodPicker({ value, onChange }: Props) {
	const [open, setOpen] = useState(false);
	const { data } = useFiscalYears();
	const fiscalYears: FiscalYear[] = data?.message ?? [];
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function handleClick(e: MouseEvent) {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	const label = describe(value);

	return (
		<div ref={rootRef} className="relative">
			<button
				type="button"
				onClick={() => setOpen((x) => !x)}
				className={cn(
					"inline-flex items-center gap-2 px-3.5 py-[7px] text-[11.5px] font-semibold rounded-full",
					"border border-border-md bg-surface text-text shadow-[0_1px_2px_rgba(40,30,15,.05)]",
					"hover:bg-surface-2 transition-colors",
				)}
				aria-expanded={open}
			>
				<svg
					className="w-3.5 h-3.5 text-text-3"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
				>
					<rect x="2" y="3" width="12" height="11" rx="1.5" />
					<path d="M2 6h12M5 1.5v3M11 1.5v3" strokeLinecap="round" />
				</svg>
				{label}
				<svg className="w-3 h-3 text-text-3" viewBox="0 0 12 12" fill="none">
					<path
						d="M3 5l3 3 3-3"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>

			{open && (
				<div
					className={cn(
						"absolute right-0 top-[calc(100%+6px)] z-40 w-[280px] p-3 rounded-xl",
						"bg-surface border border-border shadow-[0_10px_30px_rgba(40,30,15,.12)]",
					)}
				>
					<Section label="Quick">
						<OptionButton
							active={value.kind === "ttm"}
							onClick={() => {
								onChange({ kind: "ttm" });
								setOpen(false);
							}}
						>
							Trailing 12 months
						</OptionButton>
					</Section>

					{fiscalYears.length > 0 && (
						<Section label="Fiscal year">
							{fiscalYears.map((fy) => (
								<OptionButton
									key={fy.name}
									active={value.kind === "fy" && value.name === fy.name}
									onClick={() => {
										onChange({
											kind: "fy",
											name: fy.name,
											from: fy.from,
											to: fy.to,
										});
										setOpen(false);
									}}
								>
									FY {fy.name}
									<span className="text-text-3 text-[10px] font-normal ml-1">
										{formatDate(fy.from)} – {formatDate(fy.to)}
									</span>
								</OptionButton>
							))}
						</Section>
					)}

					<Section label="Custom">
						<CustomRangePicker
							current={value}
							onApply={(from, to) => {
								onChange({ kind: "custom", from, to });
								setOpen(false);
							}}
						/>
					</Section>
				</div>
			)}
		</div>
	);
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mb-3 last:mb-0">
			<div className="text-[9px] font-semibold tracking-[0.12em] uppercase text-text-3 px-1 mb-1.5">
				{label}
			</div>
			<div className="flex flex-col gap-1">{children}</div>
		</div>
	);
}

function OptionButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full text-left px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors",
				active
					? "bg-green text-white"
					: "text-text-2 hover:bg-surface-2 hover:text-text",
			)}
		>
			{children}
		</button>
	);
}

function CustomRangePicker({
	current,
	onApply,
}: {
	current: PeriodSelection;
	onApply: (from: string, to: string) => void;
}) {
	const initialFrom = current.kind === "custom" || current.kind === "fy" ? current.from : "";
	const initialTo = current.kind === "custom" || current.kind === "fy" ? current.to : "";
	const [from, setFrom] = useState(initialFrom);
	const [to, setTo] = useState(initialTo);
	const valid = from && to && from <= to;

	return (
		<div className="flex flex-col gap-1.5 px-1">
			<div className="flex items-center gap-1.5">
				<input
					type="date"
					value={from}
					onChange={(e) => setFrom(e.target.value)}
					className="flex-1 min-w-0 px-2 py-1 text-[12px] bg-surface-2 border border-border-md rounded-md text-text"
					aria-label="From date"
				/>
				<span className="text-text-3 text-[10px]">→</span>
				<input
					type="date"
					value={to}
					onChange={(e) => setTo(e.target.value)}
					className="flex-1 min-w-0 px-2 py-1 text-[12px] bg-surface-2 border border-border-md rounded-md text-text"
					aria-label="To date"
				/>
			</div>
			<button
				type="button"
				onClick={() => valid && onApply(from, to)}
				disabled={!valid}
				className={cn(
					"px-2.5 py-1 text-[11.5px] font-semibold rounded-md transition-colors",
					valid
						? "bg-green text-white hover:bg-green-mid"
						: "bg-surface-3 text-text-3 cursor-not-allowed",
				)}
			>
				Apply custom range
			</button>
		</div>
	);
}

function describe(p: PeriodSelection): string {
	if (p.kind === "ttm") return "Trailing 12M";
	if (p.kind === "fy") return `FY ${p.name}`;
	return `${formatDate(p.from)} – ${formatDate(p.to)}`;
}

function formatDate(iso: string): string {
	if (!iso) return "";
	const [y, m, d] = iso.split("-");
	const MONTHS = [
		"Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	];
	return `${MONTHS[Number(m) - 1] ?? m} ${d} ${y}`;
}
