import { useState } from "react";
import { cn } from "@/lib/utils";
import type { IntentFilter, PeriodSelection, TaxMode } from "@/types/mis";

type Format = "excel" | "pdf";

interface Props {
	taxMode: TaxMode;
	period: PeriodSelection;
	intent?: IntentFilter;
	className?: string;
}

const ENDPOINT: Record<Format, string> = {
	excel: "/api/method/company_dashboard.api.export.download_mis_workbook",
	pdf: "/api/method/company_dashboard.api.export.download_mis_pdf",
};

const LABEL: Record<Format, string> = {
	excel: "Excel",
	pdf: "PDF",
};

/** Two-button group that kicks off a same-origin form POST so the browser
 *  handles the download natively. CSRF passes as the ``csrf_token`` form field
 *  (native form-submit can't set custom headers). */
export function DownloadButtons({ taxMode, period, intent = "all", className }: Props) {
	const [busy, setBusy] = useState<Format | null>(null);

	const trigger = (format: Format) => {
		const form = document.createElement("form");
		form.method = "POST";
		form.action = ENDPOINT[format];
		form.target = "_self";
		const fields: Record<string, string> = {
			tax_mode: taxMode,
			intent,
		};
		if (period.kind !== "ttm") {
			fields.from_date = period.from;
			fields.to_date = period.to;
		}
		const csrf = window.csrf_token;
		if (csrf) fields.csrf_token = csrf;
		for (const [key, value] of Object.entries(fields)) {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = key;
			input.value = value;
			form.appendChild(input);
		}
		document.body.appendChild(form);
		setBusy(format);
		form.submit();
		document.body.removeChild(form);
		// Browser takes over once the binary arrives — clear the spinner shortly after.
		window.setTimeout(() => setBusy(null), 2000);
	};

	return (
		<div className={cn("inline-flex items-center gap-1", className)}>
			<DownloadButton
				onClick={() => trigger("excel")}
				label={LABEL.excel}
				format="excel"
				busy={busy === "excel"}
			/>
			<DownloadButton
				onClick={() => trigger("pdf")}
				label={LABEL.pdf}
				format="pdf"
				busy={busy === "pdf"}
			/>
		</div>
	);
}

function DownloadButton({
	onClick,
	label,
	format,
	busy,
}: {
	onClick: () => void;
	label: string;
	format: Format;
	busy: boolean;
}) {
	const title =
		format === "excel"
			? "Full workbook with one sheet per page"
			: "A4 report-style PDF of every page";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={busy}
			title={title}
			className={cn(
				"inline-flex items-center gap-1.5 px-3 py-[6px] text-[11px] font-semibold rounded-full",
				"border border-border-md bg-surface text-text shadow-[0_1px_2px_rgba(40,30,15,.05)]",
				"hover:bg-surface-2 transition-colors disabled:opacity-60 disabled:cursor-wait",
			)}
		>
			<svg
				className={cn(
					"w-3.5 h-3.5",
					format === "excel" ? "text-green" : "text-red",
					busy && "animate-pulse",
				)}
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				{format === "excel" ? (
					<>
						<rect x="2" y="2" width="12" height="12" rx="1.5" />
						<path d="M6 6l4 4M10 6l-4 4" />
					</>
				) : (
					<>
						<path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
						<path d="M10 2v3h3" />
					</>
				)}
			</svg>
			{busy ? "…" : label}
		</button>
	);
}
