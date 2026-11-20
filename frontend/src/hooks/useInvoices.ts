import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FrappeContext, useFrappeEventListener, useFrappeGetCall } from "frappe-react-sdk";
import type { InvoiceDetail, InvoiceFeedResponse, InvoiceRange } from "@/types/invoices";
import type { TaxMode } from "@/types/mis";

const M = "company_dashboard.api.invoices";

/** Must match REALTIME_EVENT in company_dashboard/api/invoices.py. */
export const INVOICE_EVENT = "company_dashboard_sales_invoice";

/** Fallback poll while the realtime socket is down (and the tab is visible). */
export const POLL_MS = 5 * 60_000;
/** Realtime pings within this window collapse into one refetch (bulk submits). */
const PING_DEBOUNCE_MS = 3_000;

export interface InvoiceFeedQuery {
	company: string;
	taxMode: TaxMode;
	range: InvoiceRange;
	/** Custom range only (YYYY-MM-DD). */
	from: string;
	to: string;
	search: string;
	customer: string;
	customerGroup: string;
	returnsOnly: boolean;
	start: number;
	pageLength: number;
	refreshKey: number;
}

export function useInvoiceFeed(q: InvoiceFeedQuery) {
	const params: Record<string, string> = {
		tax_mode: q.taxMode,
		range_key: q.range,
		start: String(q.start),
		page_length: String(q.pageLength),
	};
	if (q.company) params.company = q.company;
	if (q.range === "custom") {
		params.from_date = q.from;
		params.to_date = q.to;
	}
	if (q.search) params.search = q.search;
	if (q.customer) params.customer = q.customer;
	if (q.customerGroup) params.customer_group = q.customerGroup;
	if (q.returnsOnly) params.returns_only = "1";
	// A custom range without both dates isn't a query yet.
	const ready = q.range !== "custom" || (Boolean(q.from) && Boolean(q.to) && q.from <= q.to);
	const key = ready ? `inv.feed::${JSON.stringify(params)}::${q.refreshKey}` : null;
	return useFrappeGetCall<{ message: InvoiceFeedResponse }>(`${M}.get_invoice_feed`, params, key, {
		revalidateOnFocus: false,
		// Keep the current page on screen while the next filter / page loads.
		keepPreviousData: true,
		dedupingInterval: 2_000,
	});
}

/** One invoice for the dialog; `name` null = closed (no request). */
export function useInvoiceDetail(name: string | null, taxMode: TaxMode) {
	return useFrappeGetCall<{ message: InvoiceDetail }>(
		`${M}.get_invoice_detail`,
		{ name: name ?? "", tax_mode: taxMode },
		name ? `inv.detail::${name}::${taxMode}` : null,
		{ revalidateOnFocus: false, keepPreviousData: true, dedupingInterval: 30_000 },
	);
}

/**
 * Keeps the page fresh: a realtime ping on every Sales Invoice submit / cancel (debounced),
 * a 5-minute poll only while the socket is down, and one refetch when the tab comes back
 * into view. `live` is true while the socket is connected.
 */
export function useLiveInvoices(refetch: () => void): { live: boolean } {
	const socket = useContext(FrappeContext)?.socket;
	const [live, setLive] = useState<boolean>(Boolean(socket?.connected));
	const refetchRef = useRef(refetch);
	refetchRef.current = refetch;
	const timer = useRef<number | null>(null);

	useEffect(() => {
		if (!socket) return;
		const up = () => setLive(true);
		const down = () => setLive(false);
		setLive(socket.connected);
		socket.on("connect", up);
		socket.on("disconnect", down);
		socket.on("connect_error", down);
		return () => {
			socket.off("connect", up);
			socket.off("disconnect", down);
			socket.off("connect_error", down);
		};
	}, [socket]);

	const onPing = useCallback(() => {
		if (timer.current != null) return;
		timer.current = window.setTimeout(() => {
			timer.current = null;
			refetchRef.current();
		}, PING_DEBOUNCE_MS);
	}, []);
	useFrappeEventListener(INVOICE_EVENT, onPing);
	useEffect(
		() => () => {
			if (timer.current != null) window.clearTimeout(timer.current);
		},
		[],
	);

	useEffect(() => {
		if (live) return;
		const id = window.setInterval(() => {
			if (document.visibilityState === "visible") refetchRef.current();
		}, POLL_MS);
		return () => window.clearInterval(id);
	}, [live]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === "visible") refetchRef.current();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	return { live };
}
