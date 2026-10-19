import { useEffect, useState } from "react";
import { useFrappePostCall } from "frappe-react-sdk";
import { toast } from "sonner";
import { serverTimeZone } from "@/lib/boot";
import { errorMessage, parseServerTime } from "@/lib/utils";

/** `refreshed_at` is a naive server-local timestamp; read it in the site's timezone. */
function timeAgo(naive: string, now: number): string {
	const at = parseServerTime(naive, serverTimeZone());
	if (!Number.isFinite(at)) return "at an unknown time";
	const diff = Math.max(0, (now - at) / 1000);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
	return `${Math.round(diff / 86400)}d ago`;
}

export function PreparedReportHeader({
	refreshedAt,
	stale,
	section,
	onRefreshed,
}: {
	refreshedAt?: string;
	/** New ledger postings since this cache was built. */
	stale?: boolean;
	section: "mis" | "wc";
	onRefreshed: () => void;
}) {
	const { call } = useFrappePostCall("company_dashboard.api.report_cache.refresh_dashboard");
	const [refreshing, setRefreshing] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const id = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(id);
	}, []);

	const handleRefresh = async () => {
		setRefreshing(true);
		setFailure(null);
		try {
			await call({ section });
			onRefreshed();
		} catch (err) {
			const msg = errorMessage(err);
			setFailure(msg);
			toast.error("Refresh failed", { description: msg });
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<div className="flex items-center justify-between mb-5 px-0.5 gap-3">
			<div className="flex items-center gap-2 text-[11px] text-text-3 font-mono flex-wrap">
				<span
					className={`w-1.5 h-1.5 rounded-full inline-block ${stale ? "bg-amber" : "bg-green-mid"}`}
				/>
				{refreshedAt ? (
					<>Prepared report · refreshed {timeAgo(refreshedAt, now)}</>
				) : (
					<>Computing report…</>
				)}
				{stale && (
					<span className="text-amber font-sans font-medium">
						· new postings since refresh —{" "}
						<button
							type="button"
							onClick={handleRefresh}
							disabled={refreshing}
							className="underline underline-offset-2 font-semibold hover:text-text"
						>
							Refresh
						</button>
					</span>
				)}
				{failure && (
					<span className="text-red font-sans font-medium" role="alert">
						· Refresh failed: {failure}
					</span>
				)}
			</div>
			<button
				onClick={handleRefresh}
				disabled={refreshing}
				className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-md border border-border text-text-2 hover:text-text hover:bg-surface-2 disabled:opacity-40 transition-colors shrink-0"
			>
				<svg
					className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
				>
					<path d="M2 8a6 6 0 0 1 10.3-4.1M14 8a6 6 0 0 1-10.3 4.1" />
					<path d="M12.3 1v3h-3M3.7 15v-3h3" />
				</svg>
				{refreshing ? "Refreshing…" : "Refresh"}
			</button>
		</div>
	);
}
