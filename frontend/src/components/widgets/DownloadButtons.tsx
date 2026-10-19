import { useState } from "react";
import { toast } from "sonner";
import { cn, errorMessage } from "@/lib/utils";
import type { IntentFilter, PeriodSelection, TaxMode } from "@/types/mis";

type Format = "excel" | "pdf";

interface Props {
	taxMode: TaxMode;
	period: PeriodSelection;
	company?: string;
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

function filenameFrom(disposition: string | null, fallback: string): string {
	if (!disposition) return fallback;
	const star = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
	if (star) return decodeURIComponent(star[1].trim().replace(/"/g, ""));
	const plain = disposition.match(/filename="?([^";]+)"?/i);
	return plain ? plain[1].trim() : fallback;
}

/** Reads the frappe error body (JSON with exception / _server_messages) of a failed export. */
async function readError(res: Response): Promise<string> {
	try {
		const text = await res.text();
		try {
			return errorMessage({ ...JSON.parse(text), httpStatus: res.status, httpStatusText: res.statusText });
		} catch {
			const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
			return plain.slice(0, 300) || `${res.status} ${res.statusText}`;
		}
	} catch {
		return `${res.status} ${res.statusText}`;
	}
}

/** Two-button group that POSTs the current filters (with the CSRF header) and saves the
 *  returned file. A failed export shows the server's error instead of navigating away. */
export function DownloadButtons({ taxMode, period, company, intent = "all", className }: Props) {
	const [busy, setBusy] = useState<Format | null>(null);

	const trigger = async (format: Format) => {
		const fields = new URLSearchParams({ tax_mode: taxMode, intent });
		if (period.kind !== "ttm") {
			fields.set("from_date", period.from);
			fields.set("to_date", period.to);
		}
		if (company) fields.set("company", company);
		setBusy(format);
		try {
			const res = await fetch(ENDPOINT[format], {
				method: "POST",
				credentials: "same-origin",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					...(window.csrf_token ? { "X-Frappe-CSRF-Token": window.csrf_token } : {}),
				},
				body: fields.toString(),
			});
			const type = res.headers.get("Content-Type") ?? "";
			if (!res.ok || type.includes("application/json") || type.includes("text/html")) {
				throw new Error(await readError(res));
			}
			const blob = await res.blob();
			const name = filenameFrom(
				res.headers.get("Content-Disposition"),
				format === "excel" ? "MIS.xlsx" : "MIS.pdf",
			);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = name;
			document.body.appendChild(a);
			a.click();
			a.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch (err) {
			toast.error(`${LABEL[format]} export failed`, {
				description: err instanceof Error ? err.message : errorMessage(err),
			});
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className={cn("inline-flex items-center gap-1", className)}>
			<DownloadButton
				onClick={() => void trigger("excel")}
				label={LABEL.excel}
				format="excel"
				busy={busy === "excel"}
			/>
			<DownloadButton
				onClick={() => void trigger("pdf")}
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
