import { useState } from "react";
import { cn } from "@/lib/utils";
import type { IntentFilter, PeriodSelection, TaxMode } from "@/types/mis";

interface Props {
	taxMode: TaxMode;
	period: PeriodSelection;
	intent?: IntentFilter;
	className?: string;
}

/** Hits the whitelisted download endpoint via a form POST (not fetch) so the
 *  browser handles the Content-Disposition download naturally, including the
 *  CSRF token. Shows a tiny spinner state while the workbook generates. */
export function DownloadExcelButton({ taxMode, period, intent = "all", className }: Props) {
	const [busy, setBusy] = useState(false);

	const trigger = () => {
		const form = document.createElement("form");
		form.method = "POST";
		form.action = "/api/method/company_dashboard.api.export.download_mis_workbook";
		form.target = "_self";
		const csrf = window.csrf_token;
		const fields: Record<string, string> = {
			tax_mode: taxMode,
			intent,
		};
		if (period.kind !== "ttm") {
			fields.from_date = period.from;
			fields.to_date = period.to;
		}
		if (csrf) fields["X-Frappe-CSRF-Token"] = csrf;
		for (const [key, value] of Object.entries(fields)) {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = key;
			input.value = value;
			form.appendChild(input);
		}
		document.body.appendChild(form);
		setBusy(true);
		form.submit();
		document.body.removeChild(form);
		// The browser's download pop-up fires on response; reset the spinner shortly after.
		window.setTimeout(() => setBusy(false), 1500);
	};

	return (
		<button
			type="button"
			onClick={trigger}
			disabled={busy}
			title="Download the full MIS pack as Excel (one sheet per page)"
			className={cn(
				"inline-flex items-center gap-2 px-3.5 py-[7px] text-[11.5px] font-semibold rounded-full",
				"border border-border-md bg-surface text-text shadow-[0_1px_2px_rgba(40,30,15,.05)]",
				"hover:bg-surface-2 transition-colors disabled:opacity-60 disabled:cursor-wait",
				className,
			)}
		>
			<svg
				className={cn("w-3.5 h-3.5 text-green", busy && "animate-pulse")}
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M8 2v9" />
				<path d="M4 7l4 4 4-4" />
				<path d="M2 13h12" />
			</svg>
			{busy ? "Preparing…" : "Excel"}
		</button>
	);
}
