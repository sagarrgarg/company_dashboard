import { cn } from "@/lib/utils";
import type { TaxMode } from "@/types/mis";

interface Props {
	value: TaxMode;
	onChange: (mode: TaxMode) => void;
}

const MODES: Array<{ key: TaxMode; label: string; hint: string }> = [
	{ key: "incl", label: "Tax Incl.", hint: "Gross of GST" },
	{ key: "excl", label: "Tax Excl.", hint: "Net of GST" },
];

export function TaxModeTabs({ value, onChange }: Props) {
	return (
		<div
			className="inline-flex items-center p-1 rounded-full border border-border-md bg-surface shadow-[0_1px_2px_rgba(40,30,15,.05)]"
			role="tablist"
			aria-label="Tax mode"
		>
			{MODES.map((m) => {
				const active = m.key === value;
				return (
					<button
						key={m.key}
						type="button"
						role="tab"
						aria-selected={active}
						title={m.hint}
						onClick={() => onChange(m.key)}
						className={cn(
							"px-3.5 py-[5px] text-[11px] font-semibold rounded-full transition-all tracking-wide",
							active
								? "bg-green text-white shadow-[0_1px_2px_rgba(31,95,51,.25)]"
								: "text-text-2 hover:text-text hover:bg-surface-2",
						)}
					>
						{m.label}
					</button>
				);
			})}
		</div>
	);
}
