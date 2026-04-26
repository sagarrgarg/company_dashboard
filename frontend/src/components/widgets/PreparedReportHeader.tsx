import { useState } from "react";
import { useFrappePostCall } from "frappe-react-sdk";

function timeAgo(iso: string): string {
	const diff = (Date.now() - new Date(iso).getTime()) / 1000;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
	return `${Math.round(diff / 86400)}d ago`;
}

export function PreparedReportHeader({
	refreshedAt,
	section,
	onRefreshed,
}: {
	refreshedAt?: string;
	section: "mis" | "wc";
	onRefreshed: () => void;
}) {
	const { call } = useFrappePostCall("company_dashboard.api.report_cache.refresh_dashboard");
	const [refreshing, setRefreshing] = useState(false);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			await call({ section });
			onRefreshed();
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<div className="flex items-center justify-between mb-5 px-0.5">
			<div className="flex items-center gap-2 text-[11px] text-text-3 font-mono">
				<span className="w-1.5 h-1.5 rounded-full bg-green-mid inline-block" />
				{refreshedAt ? (
					<>Prepared report · refreshed {timeAgo(refreshedAt)}</>
				) : (
					<>Computing report…</>
				)}
			</div>
			<button
				onClick={handleRefresh}
				disabled={refreshing}
				className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-md border border-border text-text-2 hover:text-text hover:bg-surface-2 disabled:opacity-40 transition-colors"
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
