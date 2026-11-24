/** /mis/invoices — Sales Invoices: the newest invoice on top (with each line's sale rate and
 *  COGS rate), KPIs and a filterable list below; a row opens the same detail in a dialog.
 *  Rules (COGS = incoming rate, ex-tax margins…) live in company_dashboard/api/invoices.py.
 *  Fresh via realtime pings, with a 5-minute poll while the socket is down. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { DrillSkeleton, DrillTh, ExtLink, Pager, StatTile } from "@/components/drill/DrillLayout";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { useInvoiceDetail, useInvoiceFeed, useLiveInvoices } from "@/hooks/useInvoices";
import { useUrlNumber, useUrlParam, useUrlPatch } from "@/lib/urlState";
import { MINUS, cn, errorMessage, formatINR, formatMargin, formatNumber, marginState, marginTitle, shortDate } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { InvoiceDetail, InvoiceFeedResponse, InvoiceLine, InvoiceRange, InvoiceRow } from "@/types/invoices";
import { INVOICE_RANGES } from "@/types/invoices";
import type { TaxMode } from "@/types/mis";

const PAGE = 20;
const SEARCH_DEBOUNCE_MS = 400;

const RANGE_LABEL: Record<InvoiceRange, string> = {
	today: "Today",
	"7d": "7 days",
	"30d": "30 days",
	month: "This month",
	fy: "This FY",
	custom: "Custom",
};

/* ── formatting ─────────────────────────────────────────────────────────── */

const IN_0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const IN_2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Exact rupees with Indian grouping: "₹1,24,560", "−₹18,400", "₹145.00" (dp = 2). */
function rupees(v: number | null | undefined, dp: 0 | 2 = 0): string {
	if (v == null || !Number.isFinite(v)) return "—";
	const body = (dp === 2 ? IN_2 : IN_0).format(Math.abs(v));
	const zero = Number(Math.abs(v).toFixed(dp)) === 0;
	return `${v < 0 && !zero ? MINUS : ""}₹${body}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-02T17:34:39" (server-local) → "2 Nov 2026, 5:34 PM" — no timezone shift. */
function postedLabel(iso: string): string {
	const m = iso.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/);
	if (!m) return iso;
	const h = Number(m[4]);
	const h12 = h % 12 || 12;
	return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${h12}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
}

type Tone = "green" | "amber" | "red" | "muted";

/** ≥ 25% green, 10–25% amber, below 10% red; n/a and impossible margins muted. */
function marginTone(pct: number | null | undefined): Tone {
	if (marginState(pct) !== "ok" || pct == null) return "muted";
	if (pct >= 25) return "green";
	if (pct >= 10) return "amber";
	return "red";
}

const TONE_CHIP: Record<Tone, string> = {
	green: "bg-green-bg text-green",
	amber: "bg-amber-bg text-amber",
	red: "bg-red-bg text-red",
	muted: "bg-surface-2 text-text-3",
};

function MarginChip({ pct, prefix, className }: { pct: number | null | undefined; prefix?: string; className?: string }) {
	return (
		<span
			className={cn("inline-block rounded-[6px] px-2 py-[2px] text-[11.5px] font-semibold tabular-nums", TONE_CHIP[marginTone(pct)], className)}
			title={marginTitle(pct) ?? "Ex-tax, over lines with a COGS rate"}
		>
			{prefix}
			{formatMargin(pct)}
		</span>
	);
}

const FLAG_TITLE =
	"COGS looks mis-valued — more than 5× the line's revenue, or under 10% of the item's BOM cost (stock that came in at a zero or token rate). Almost always a stock-valuation error. Shown, but left out of COGS, gross profit and margin until it is fixed.";

const FLAG_REASON_TITLE: Record<"high_cogs" | "low_cogs", string> = {
	high_cogs:
		"COGS is more than 5× this line's revenue — almost always a stock-valuation error. Left out of COGS, gross profit and margin until it is fixed.",
	low_cogs:
		"COGS is under 10% of the item's reference cost (its BOM cost, or for a traded item its last purchase rate) — the stock most likely came in at a zero or token rate (e.g. a Material Receipt / transfer without a rate). Fix the stock valuation; until then the line is left out of COGS, gross profit and margin.",
};

/** Repost drift: the stock ledger now books a different cost than the invoice's incoming rate. */
function driftTitle(ln: InvoiceLine): string {
	const booked = ln.booked_cogs_amount ?? 0;
	const perUnit = ln.qty ? booked / ln.qty : null;
	return `The stock ledger now books ${rupees(booked, 2)} for this line (${rupees(perUnit, 2)} per ${ln.uom}) — usually after a repost of a backdated entry, which doesn't update the invoice's incoming rate. COGS here stays the incoming rate ${rupees(ln.cogs_amount, 2)}; the P&L uses the booked value.`;
}

/** Flag tooltip for one line, naming the reference it was compared with. */
function lineFlagTitle(ln: InvoiceLine): string {
	if (ln.flag_reason === "low_cogs" && ln.ref_rate != null) {
		const ref = ln.ref_source === "bom" ? "BOM cost" : "last purchase rate";
		return `COGS ${rupees(ln.cogs_rate, 2)} is under 10% of the ${ref} ${rupees(ln.ref_rate, 2)} — the stock most likely came in at a zero or token rate (e.g. a Material Receipt / transfer without a rate). Fix the stock valuation; until then the line is left out of COGS, gross profit and margin.`;
	}
	return ln.flag_reason ? FLAG_REASON_TITLE[ln.flag_reason] : FLAG_TITLE;
}

const COGS_SOURCE_TITLE: Record<string, string> = {
	invoice: "Incoming rate on the invoice",
	delivery_note: "Incoming rate from the Delivery Note",
	stock_ledger: "Booked value of the stock that came back (stock ledger)",
};

/** "+12.4%" / "−3.0%". */
function signedPct(v: number): string {
	return `${v > 0 ? "+" : v < 0 ? MINUS : ""}${Math.abs(v).toFixed(1)}%`;
}

/** Actual COGS vs BOM: within ±5% on plan, above = cost overrun (red), below = under plan. */
function varianceTone(v: number): string {
	if (Math.abs(v) <= 5) return "text-text-3";
	return v > 0 ? "text-red" : "text-green";
}

/** Gap beyond ±50%: which side is likely wrong depends on the direction. */
const BOM_CHECK_HIGH_TITLE =
	"Actual cost is more than 50% above the BOM cost — the BOM is most likely out of date (run Update Cost) or its quantities/units are wrong; or the stock is over-valued. Left out of the BOM total.";
const BOM_CHECK_LOW_TITLE =
	"Actual cost is more than 50% below the BOM cost — the stock was most likely valued too low (received or transferred at a zero / low rate); or the BOM is inflated. Left out of the BOM total.";

/** BOM rate cell: planned rate, then the variance of the actual COGS against it. */
function BomCell({ ln }: { ln: InvoiceLine }) {
	if (ln.bom_rate == null) {
		return (
			<span className="text-text-4 cursor-help" title="No BOM for this item (traded item, no default/active BOM, or BOM in another unit)">
				— <span aria-hidden="true">ⓘ</span>
			</span>
		);
	}
	const title = `${ln.bom} — planned cost as of its last save or "Update Cost"${
		ln.bom_saved_on ? ` (last saved ${shortDate(ln.bom_saved_on)})` : ""
	}. Reference only; COGS stays the incoming rate.`;
	const v = ln.bom_variance_pct;
	return (
		<div className="inline-flex flex-col items-end leading-tight">
			<span className="text-text-2 cursor-help" title={title}>
				{rupees(ln.bom_rate, 2)}
			</span>
			{v != null &&
				(ln.flagged ? (
					<span className="text-[11px] font-semibold text-amber cursor-help" title={lineFlagTitle(ln)}>
						⚠ {signedPct(v)} vs BOM
					</span>
				) : ln.bom_variance_check ? (
					<span className="text-[11px] font-semibold text-amber cursor-help" title={v > 0 ? BOM_CHECK_HIGH_TITLE : BOM_CHECK_LOW_TITLE}>
						⚠ {signedPct(v)} {v > 0 ? "check BOM" : "check valuation"}
					</span>
				) : (
					<span className={cn("text-[11px] font-semibold", varianceTone(v))} title="Actual COGS vs BOM cost (positive = cost more than planned)">
						{signedPct(v)} vs BOM
					</span>
				))}
		</div>
	);
}

function FlagChip({ title = FLAG_TITLE }: { title?: string }) {
	return (
		<span className="inline-block rounded-[6px] px-2 py-[2px] text-[11.5px] font-semibold bg-amber-bg text-amber cursor-help" title={title}>
			⚠ Check
		</span>
	);
}

/* ── page ───────────────────────────────────────────────────────────────── */

export function SalesInvoicesPage({ query, onTaxModeChange, onLoaded }: MisPageProps) {
	const [range] = useUrlParam<InvoiceRange>("range", "30d", INVOICE_RANGES);
	// Not "from"/"to": those carry the dashboard period.
	const [from] = useUrlParam<string>("inv_from", "");
	const [to] = useUrlParam<string>("inv_to", "");
	const [search] = useUrlParam<string>("q", "");
	const [customer] = useUrlParam<string>("customer", "");
	const [customerGroup] = useUrlParam<string>("group", "");
	const [returns] = useUrlParam<string>("returns", "");
	const [start, setStart] = useUrlNumber("start", 0);
	const [openName, setOpenName] = useUrlParam<string>("inv", "");
	const patch = useUrlPatch();
	const [refreshKey, setRefreshKey] = useState(0);

	const { data, error, isLoading, isValidating, mutate } = useInvoiceFeed({
		company: query.company,
		taxMode: query.taxMode,
		range,
		from,
		to,
		search,
		customer,
		customerGroup,
		returnsOnly: returns === "1",
		start,
		pageLength: PAGE,
		refreshKey: query.refreshKey + refreshKey,
	});
	const d = data?.message;

	const refetch = useCallback(() => {
		void mutate();
	}, [mutate]);
	const { live } = useLiveInvoices(refetch);

	// "updated n min ago" — the moment the last response arrived.
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [, tick] = useState(0);
	useEffect(() => {
		if (d) setUpdatedAt(Date.now());
	}, [d]);
	useEffect(() => {
		const id = window.setInterval(() => tick((n) => n + 1), 30_000);
		return () => window.clearInterval(id);
	}, []);

	useEffect(() => {
		if (d) onLoaded(d.company);
	}, [d, onLoaded]);

	// A failed refresh (e.g. the rate limit) keeps the last data on screen — say so.
	const hasData = Boolean(d);
	useEffect(() => {
		if (error && hasData) toast.error("Couldn't refresh invoices", { description: errorMessage(error) });
	}, [error, hasData]);

	// Toast when a new invoice takes the top spot (not on first load / company switch).
	const lastLatest = useRef<{ company: string; name: string } | null>(null);
	useEffect(() => {
		if (!d) return;
		const name = d.latest?.name ?? "";
		const prev = lastLatest.current;
		if (prev && prev.company === d.company && name && prev.name !== name && d.latest) {
			toast.success(`New invoice ${name}`, { description: d.latest.customer_name });
		}
		lastLatest.current = { company: d.company, name };
	}, [d]);

	const rows = d?.rows ?? [];
	const openIndex = openName ? rows.findIndex((r) => r.name === openName) : -1;

	const header = (
		<header className="flex flex-col md:flex-row md:justify-between md:items-start gap-4 mb-5">
			<div className="min-w-0">
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">Revenue · sales invoices</div>
				<h1 className="font-serif text-[24px] md:text-[28px] leading-[1.15] text-text tracking-tight">Sales Invoices</h1>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1.5 text-[12px] text-text-2 font-medium">
					<span>Latest first{updatedAt ? ` · updated ${agoLabel(updatedAt)}` : ""}</span>
					<LiveBadge live={live} />
					{isValidating && d && <span className="text-text-3">Updating…</span>}
				</div>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				<TaxModeTabs value={query.taxMode} onChange={onTaxModeChange} />
				<button
					type="button"
					onClick={() => setRefreshKey((k) => k + 1)}
					className="w-9 h-9 flex items-center justify-center rounded-full border border-border-md bg-surface text-text-2 hover:bg-surface-2 hover:text-text"
					aria-label="Refresh"
					title="Refresh"
				>
					<svg className={cn("w-4 h-4", isValidating && "animate-spin")} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
						<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			</div>
		</header>
	);

	if (isLoading && !d) return (<>{header}<DrillSkeleton /></>);
	if (error && !d) {
		return (<>{header}<ErrorCard title="Unable to load invoices" error={error} /></>);
	}
	if (!d) return (<>{header}<DrillSkeleton /></>);

	const k = d.kpi;
	return (
		<>
			{header}

			<div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
				<StatTile
					label="Invoices"
					value={formatNumber(k.invoice_count)}
					sub={
						<>
							{k.today_count > 0 && <span className="badge !py-0 bg-green-bg text-green">+{formatNumber(k.today_count)} today</span>}
							<span>{k.return_count ? `${formatNumber(k.return_count)} returns` : "in range"}</span>
						</>
					}
				/>
				<StatTile
					label="Sales value"
					value={formatINR(k.sales)}
					tone={k.sales < 0 ? "red" : "default"}
					sub={query.taxMode === "incl" ? "incl. tax, net of returns" : "ex-tax, net of returns"}
				/>
				<StatTile
					label="COGS"
					value={formatINR(k.cogs)}
					sub={
						<>
							<span>{k.lines_without_cogs ? `${formatNumber(k.lines_without_cogs)} lines without COGS` : "incoming rate · returns at booked value"}</span>
							{k.lines_flagged > 0 && (
								<span className="badge !py-0 bg-amber-bg text-amber cursor-help" title={FLAG_TITLE}>
									⚠ {formatNumber(k.lines_flagged)} flagged
								</span>
							)}
						</>
					}
				/>
				<StatTile label="Gross margin" value={<span title={marginTitle(k.margin_pct)}>{formatMargin(k.margin_pct)}</span>} sub="ex-tax, valued lines only" />
			</div>

			{d.latest ? (
				<section className="card !p-0 overflow-hidden mb-4 border-l-[3px] !border-l-green" aria-label="Latest invoice">
					<InvoiceBody inv={d.latest} taxMode={query.taxMode} latest />
				</section>
			) : (
				<div className="card mb-4 text-[13px] text-text-2">No submitted sales invoices yet for {d.company}.</div>
			)}

			<InvoiceList
				d={d}
				rows={rows}
				range={range}
				from={from}
				to={to}
				search={search}
				customer={customer}
				customerGroup={customerGroup}
				returnsOnly={returns === "1"}
				taxMode={query.taxMode}
				patch={patch}
				onOpen={setOpenName}
				onPage={setStart}
			/>

			<InvoiceDialog
				name={openName || null}
				taxMode={query.taxMode}
				position={openIndex >= 0 ? d.start + openIndex + 1 : null}
				total={d.total_count}
				onClose={() => setOpenName("")}
				onPrev={openIndex > 0 ? () => setOpenName(rows[openIndex - 1].name) : undefined}
				onNext={openIndex >= 0 && openIndex < rows.length - 1 ? () => setOpenName(rows[openIndex + 1].name) : undefined}
			/>
		</>
	);
}

function agoLabel(ts: number): string {
	const mins = Math.floor((Date.now() - ts) / 60_000);
	if (mins < 1) return "just now";
	if (mins === 1) return "1 min ago";
	if (mins < 60) return `${mins} min ago`;
	const h = Math.floor(mins / 60);
	return `${h} h ago`;
}

function LiveBadge({ live }: { live: boolean }) {
	return live ? (
		<span className="inline-flex items-center gap-1.5 px-2 py-[1px] rounded-full bg-green-bg text-green text-[11px] font-semibold" title="New invoices appear as soon as they are submitted">
			<span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" aria-hidden="true" />
			Live
		</span>
	) : (
		<span className="inline-flex items-center gap-1.5 px-2 py-[1px] rounded-full bg-surface-2 text-text-3 text-[11px] font-semibold" title="Realtime connection unavailable">
			<span className="w-1.5 h-1.5 rounded-full bg-text-4" aria-hidden="true" />
			Auto-refresh every 5 min
		</span>
	);
}

/* ── invoice body (hero card + dialog) ──────────────────────────────────── */

function InvoiceBody({ inv, taxMode, latest = false }: { inv: InvoiceDetail; taxMode: TaxMode; latest?: boolean }) {
	const t = inv.totals;
	const isReturn = Boolean(inv.is_return);
	const count = (pred: (l: InvoiceLine) => boolean) => inv.lines.filter(pred).length;
	const flaggedHigh = count((l) => l.flag_reason === "high_cogs");
	const flaggedLow = count((l) => l.flag_reason === "low_cogs");
	const checkHigh = count((l) => l.bom_variance_check && (l.bom_variance_pct ?? 0) > 0);
	const checkLow = count((l) => l.bom_variance_check && (l.bom_variance_pct ?? 0) < 0);
	return (
		<>
			<div className="px-5 pt-4 pb-3">
				<div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
					<div className="flex items-center gap-2.5 flex-wrap min-w-0">
						{latest && (
							<span className="inline-flex items-center gap-1.5 rounded-full bg-green-bg text-green px-2.5 py-[3px] text-[10.5px] font-bold tracking-[0.08em] uppercase">
								<span className="w-1.5 h-1.5 rounded-full bg-green" aria-hidden="true" />
								Latest
							</span>
						)}
						<ExtLink href={inv.url} variant="inline" className="text-[16px] font-semibold !text-text hover:!text-green">
							{inv.name}
						</ExtLink>
						{inv.customer_group && <span className="badge !py-[1px] bg-blue-bg text-blue">{inv.customer_group}</span>}
						{isReturn && (
							<span className="badge !py-[1px] bg-red-bg text-red" title={inv.return_against ? `Against ${inv.return_against}` : undefined}>
								Return
							</span>
						)}
					</div>
					<div className="flex items-center gap-3 sm:justify-end">
						<MarginChip pct={t.margin_pct} prefix="Margin " />
						<div className="text-right">
							<div className={cn("text-[24px] font-semibold leading-[1.05] tracking-tight tabular-nums", isReturn ? "text-red" : "text-text")}>
								{rupees(t.grand_total)}
							</div>
							<div className="text-[11px] text-text-3">grand total, incl. tax</div>
						</div>
					</div>
				</div>
				<div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[8px] bg-[#faf8f2] px-3 py-2 text-[12.5px] text-text-2">
					<span className="font-semibold text-text">{inv.customer_name}</span>
					<span className="text-text-4" aria-hidden="true">•</span>
					<span>{postedLabel(inv.posted_at)}</span>
					<span className="text-text-4" aria-hidden="true">•</span>
					<span>
						{formatNumber(inv.item_count)} {inv.item_count === 1 ? "item" : "items"}
					</span>
				</div>
			</div>

			<ItemsTable inv={inv} taxMode={taxMode} />

			<div className="px-5 py-4 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
				<div className="text-[12px] text-text-2 space-y-0.5">
					<div>
						COGS <span className="font-semibold text-text tabular-nums">{rupees(t.cogs)}</span>
						{t.gross_profit != null && (
							<>
								{" · "}gross profit{" "}
								<span className={cn("font-semibold tabular-nums", t.gross_profit < 0 ? "text-red" : "text-text")}>{rupees(t.gross_profit)}</span> (ex-tax)
							</>
						)}
					</div>
					{t.lines_without_cogs > 0 && (
						<div className="text-text-3">
							{formatNumber(t.lines_without_cogs)} {t.lines_without_cogs === 1 ? "line has" : "lines have"} no COGS — left out of COGS and margin.
						</div>
					)}
					{flaggedHigh > 0 && (
						<div className="text-amber" title={FLAG_REASON_TITLE.high_cogs}>
							⚠ {formatNumber(flaggedHigh)} {flaggedHigh === 1 ? "line looks" : "lines look"} mis-valued (COGS &gt; 5× revenue) — left out of COGS and margin.
						</div>
					)}
					{flaggedLow > 0 && (
						<div className="text-amber" title={FLAG_REASON_TITLE.low_cogs}>
							⚠ {formatNumber(flaggedLow)} {flaggedLow === 1 ? "line's" : "lines'"} COGS is under 10% of the BOM cost / last purchase rate — stock likely valued at a zero/low rate; left out of COGS and margin.
						</div>
					)}
					{t.bom.planned != null && t.bom.variance_pct != null && (
						<div title="Planned (BOM) cost vs actual COGS over the lines that have a BOM. Reference only — COGS stays the incoming rate.">
							BOM cost <span className="font-semibold text-text tabular-nums">{rupees(t.bom.planned)}</span>
							{" vs actual "}
							<span className="font-semibold text-text tabular-nums">{rupees(t.bom.actual)}</span>{" "}
							<span className={cn("font-semibold tabular-nums", varianceTone(t.bom.variance_pct))}>({signedPct(t.bom.variance_pct)})</span>
							<span className="text-text-3">
								{" "}
								· {formatNumber(t.bom.compared)} of {formatNumber(t.bom.lines)} BOM {t.bom.lines === 1 ? "line" : "lines"}
							</span>
						</div>
					)}
					{t.lines_drifted > 0 && (
						<div className="text-text-3" title="A repost (after a backdated stock entry) rewrites the stock ledger but not the invoice's incoming rate. Hover ≠GL on a line for the booked value.">
							{formatNumber(t.lines_drifted)} {t.lines_drifted === 1 ? "line's" : "lines'"} booked stock value now differs from the incoming rate (≠GL) — usually a repost; COGS here stays the incoming rate.
						</div>
					)}
					{checkHigh > 0 && (
						<div className="text-amber" title={BOM_CHECK_HIGH_TITLE}>
							⚠ {formatNumber(checkHigh)} {checkHigh === 1 ? "line costs" : "lines cost"} over 50% more than the BOM — likely an outdated BOM; left out of the BOM total.
						</div>
					)}
					{checkLow > 0 && (
						<div className="text-amber" title={BOM_CHECK_LOW_TITLE}>
							⚠ {formatNumber(checkLow)} {checkLow === 1 ? "line costs" : "lines cost"} over 50% less than the BOM — check the stock valuation; left out of the BOM total.
						</div>
					)}
				</div>
				<dl className="w-full sm:w-72 rounded-[10px] bg-[#faf8f2] px-4 py-3 text-[12.5px] space-y-1 tabular-nums">
					<SummaryRow label="Net total (ex-tax)" value={rupees(t.net_total, 2)} />
					{t.discount !== 0 && <SummaryRow label="Discount" value={rupees(-Math.abs(t.discount), 2)} />}
					<SummaryRow label="Taxes" value={rupees(t.taxes, 2)} />
					{Math.abs(t.rounding) >= 0.005 && <SummaryRow label="Rounding" value={rupees(t.rounding, 2)} />}
					<div className="flex justify-between items-baseline pt-1.5 mt-1 border-t border-border">
						<dt className="font-serif text-[15px] text-text">Grand total</dt>
						<dd className="text-[17px] font-semibold text-text">{rupees(t.grand_total, 2)}</dd>
					</div>
				</dl>
			</div>
		</>
	);
}

function SummaryRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-3">
			<dt className="text-text-2">{label}</dt>
			<dd className="font-semibold text-text">{value}</dd>
		</div>
	);
}

function ItemsTable({ inv, taxMode }: { inv: InvoiceDetail; taxMode: TaxMode }) {
	const t = inv.totals;
	const rateNote = taxMode === "incl" ? "incl. tax" : "ex-tax";
	// Quantities only add up within one unit: 2 Kg + 3 Nos is not "5".
	const uoms = new Set(inv.lines.map((l) => l.uom));
	const oneUom = uoms.size === 1 ? inv.lines[0]?.uom : null;
	return (
		<div className="px-5 md:px-0 border-t border-border">
			<table className="drill-table w-full text-[12.5px] tabular-nums">
				<thead className="bg-[#faf8f2]">
					<tr>
						<DrillTh align="left">
							<span className="md:pl-2">#</span>
						</DrillTh>
						<DrillTh align="left">Item</DrillTh>
						<DrillTh>Qty</DrillTh>
						<DrillTh>Sale rate</DrillTh>
						<DrillTh>COGS rate</DrillTh>
						<DrillTh>BOM rate</DrillTh>
						<DrillTh>Amount</DrillTh>
						<DrillTh>Margin</DrillTh>
					</tr>
				</thead>
				<tbody>
					{inv.lines.map((ln) => (
						<tr key={ln.idx} className="border-b border-border hover:bg-[#faf8f2]">
							<td className="hidden md:table-cell md:pl-5 md:pr-2 py-2.5 text-text-4 w-10">{String(ln.idx).padStart(2, "0")}</td>
							<td className="drill-primary md:px-3 py-2.5">
								<div className="font-semibold text-text">{ln.item_name}</div>
								{ln.item_name !== ln.item_code && <div className="text-[11px] text-text-3 font-normal">{ln.item_code}</div>}
							</td>
							<td data-label="Qty" className="md:px-3 py-2.5 text-right whitespace-nowrap">
								{formatNumber(ln.qty, Number.isInteger(ln.qty) ? 0 : 2)} <span className="text-text-3">{ln.uom}</span>
							</td>
							<td data-label={`Sale rate (${rateNote})`} className="md:px-3 py-2.5 text-right whitespace-nowrap">{rupees(ln.sale_rate, 2)}</td>
							<td data-label="COGS rate" className="md:px-3 py-2.5 text-right whitespace-nowrap text-text-2">
								{ln.cogs_rate == null ? (
									<span
										className="text-text-4"
										title={inv.is_return ? "No stock came back on this credit note" : "No incoming rate (non-stock item, or no stock entry for this line)"}
									>
										— <span aria-hidden="true">ⓘ</span>
									</span>
								) : (
									<span className={cn(ln.flagged && "text-amber")} title={COGS_SOURCE_TITLE[ln.cogs_source ?? "invoice"]}>
										{rupees(ln.cogs_rate, 2)}
										{ln.cogs_source === "delivery_note" && <sup className="ml-0.5 text-[9px] text-text-3">DN</sup>}
										{ln.cogs_source === "stock_ledger" && <sup className="ml-0.5 text-[9px] text-text-3">SLE</sup>}
										{ln.cogs_drift && ln.booked_cogs_amount != null && (
											<sup className="ml-0.5 text-[9px] font-semibold text-amber cursor-help" title={driftTitle(ln)}>
												≠GL
											</sup>
										)}
									</span>
								)}
							</td>
							<td data-label="BOM rate" className="md:px-3 py-2.5 text-right whitespace-nowrap">
								<BomCell ln={ln} />
							</td>
							<td data-label="Amount" className={cn("md:px-3 py-2.5 text-right font-semibold whitespace-nowrap", ln.amount < 0 && "text-red")}>
								{rupees(ln.amount, 2)}
							</td>
							<td data-label="Margin" className="md:pl-3 md:pr-5 py-2.5 text-right">
								{ln.cogs_rate == null ? (
									<span className="text-text-4">—</span>
								) : ln.flagged ? (
									<FlagChip title={lineFlagTitle(ln)} />
								) : (
									<MarginChip pct={ln.margin_pct} />
								)}
							</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr className="bg-[#faf8f2] font-semibold [border-bottom:3px_double_var(--border-strong)]">
						<td className="hidden md:table-cell" />
						<td className="drill-primary md:px-3 py-2.5 text-text">
							Total ({formatNumber(inv.lines.length)} {inv.lines.length === 1 ? "item" : "items"})
						</td>
						<td data-label="Qty" className="md:px-3 py-2.5 text-right whitespace-nowrap">
							{oneUom ? (
								<>
									{formatNumber(t.qty, Number.isInteger(t.qty) ? 0 : 2)} <span className="text-text-3 font-normal">{oneUom}</span>
								</>
							) : (
								<span className="text-text-3 font-normal" title={`Units differ (${[...uoms].join(", ")}) — quantities don't add up`}>
									mixed units
								</span>
							)}
						</td>
						<td className="hidden md:table-cell" />
						<td className="hidden md:table-cell" />
						<td className="hidden md:table-cell" />
						<td data-label="Amount" className={cn("md:px-3 py-2.5 text-right whitespace-nowrap", t.amount < 0 && "text-red")}>{rupees(t.amount, 2)}</td>
						<td data-label="Blended margin" className="md:pl-3 md:pr-5 py-2.5 text-right">
							<MarginChip pct={t.margin_pct} />
						</td>
					</tr>
				</tfoot>
			</table>
		</div>
	);
}

/* ── list ───────────────────────────────────────────────────────────────── */

function InvoiceList({
	d,
	rows,
	range,
	from,
	to,
	search,
	customer,
	customerGroup,
	returnsOnly,
	taxMode,
	patch,
	onOpen,
	onPage,
}: {
	d: InvoiceFeedResponse;
	rows: InvoiceRow[];
	range: InvoiceRange;
	from: string;
	to: string;
	search: string;
	customer: string;
	customerGroup: string;
	returnsOnly: boolean;
	taxMode: TaxMode;
	patch: ReturnType<typeof useUrlPatch>;
	onOpen: (name: string) => void;
	onPage: (start: number) => void;
}) {
	// Search box: local while typing, written to the URL after a pause.
	const [text, setText] = useState(search);
	useEffect(() => setText(search), [search]);
	useEffect(() => {
		if (text.trim() === search) return;
		const id = window.setTimeout(() => patch({ q: text.trim() || null, start: null }), SEARCH_DEBOUNCE_MS);
		return () => window.clearTimeout(id);
	}, [text, search, patch]);

	const setRange = (r: InvoiceRange) => {
		if (r === "custom") {
			// Seed the custom range with the current one, so it is a valid query at once.
			patch({ range: r, inv_from: from || d.range.from, inv_to: to || d.range.to, start: null });
		} else {
			patch({ range: r === "30d" ? null : r, inv_from: null, inv_to: null, start: null });
		}
	};
	const filtered = Boolean(search || customer || customerGroup || returnsOnly || range !== "30d");
	const customerOptions = useMemo(() => {
		const opts = d.filters.customers;
		return customer && !opts.some((o) => o.value === customer) ? [{ value: customer, label: customer }, ...opts] : opts;
	}, [d.filters.customers, customer]);

	const select =
		"h-9 pl-3 pr-8 rounded-[8px] border border-border-md bg-surface text-[12.5px] text-text max-w-[240px] truncate focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(31,95,51,.3)]";

	return (
		<section className="card !p-0 overflow-hidden" aria-label="All invoices">
			<div className="px-5 pt-4 pb-3 border-b border-border space-y-3">
				<div className="flex items-center justify-between gap-3 flex-wrap">
					<div className="flex items-center gap-2.5">
						<h2 className="font-serif text-[19px] text-text leading-tight">All invoices</h2>
						<span className="badge !py-[1px] bg-surface-2 text-text-2 tabular-nums">{formatNumber(d.total_count)}</span>
					</div>
					<div className="text-[11.5px] text-text-3 tabular-nums">
						{shortDate(d.range.from)} – {shortDate(d.range.to)} · {taxMode === "incl" ? "incl. tax" : "ex-tax"}
					</div>
				</div>

				<div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
					<div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Date range">
						{INVOICE_RANGES.map((r) => (
							<button
								key={r}
								type="button"
								aria-pressed={range === r}
								onClick={() => setRange(r)}
								className={cn(
									"px-3 min-h-[30px] rounded-full text-[12px] font-medium transition-colors",
									range === r ? "bg-green-bg text-green font-semibold" : "border border-border-md bg-surface text-text-2 hover:bg-surface-2",
								)}
							>
								{RANGE_LABEL[r]}
							</button>
						))}
					</div>
					<label className="relative block lg:w-72">
						<span className="sr-only">Search customer or invoice no.</span>
						<svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-4 pointer-events-none" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
							<circle cx="7" cy="7" r="4.5" />
							<path d="M10.5 10.5L14 14" strokeLinecap="round" />
						</svg>
						<input
							type="search"
							value={text}
							onChange={(e) => setText(e.target.value)}
							placeholder="Search customer or invoice no."
							className="w-full h-9 pl-9 pr-3 rounded-[8px] border border-border-md bg-surface text-[13px] text-text placeholder:text-text-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(31,95,51,.3)]"
						/>
					</label>
				</div>

				{range === "custom" && (
					<div className="flex flex-wrap items-center gap-2 text-[12px] text-text-2">
						<label className="flex items-center gap-1.5">
							From
							<input
								type="date"
								value={from}
								max={to || undefined}
								onChange={(e) => patch({ inv_from: e.target.value || null, start: null })}
								className="h-9 px-2 rounded-[8px] border border-border-md bg-surface text-text"
							/>
						</label>
						<label className="flex items-center gap-1.5">
							To
							<input
								type="date"
								value={to}
								min={from || undefined}
								onChange={(e) => patch({ inv_to: e.target.value || null, start: null })}
								className="h-9 px-2 rounded-[8px] border border-border-md bg-surface text-text"
							/>
						</label>
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2.5">
					<label>
						<span className="sr-only">Customer</span>
						<select value={customer} onChange={(e) => patch({ customer: e.target.value || null, start: null })} className={select}>
							<option value="">Customer: All</option>
							{customerOptions.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label.trim() || o.value}
								</option>
							))}
						</select>
					</label>
					<label>
						<span className="sr-only">Customer group</span>
						<select value={customerGroup} onChange={(e) => patch({ group: e.target.value || null, start: null })} className={select}>
							<option value="">Customer group: All</option>
							{d.filters.customer_groups.map((g) => (
								<option key={g} value={g}>
									{g}
								</option>
							))}
						</select>
					</label>
					<label className="inline-flex items-center gap-2 h-9 px-3 rounded-[8px] border border-border-md bg-surface text-[12.5px] text-text-2 cursor-pointer select-none">
						<input
							type="checkbox"
							checked={returnsOnly}
							onChange={(e) => patch({ returns: e.target.checked ? "1" : null, start: null })}
							className="accent-[var(--green)]"
						/>
						Returns only
					</label>
					{filtered && (
						<button
							type="button"
							onClick={() => {
								setText("");
								patch({ range: null, inv_from: null, inv_to: null, q: null, customer: null, group: null, returns: null, start: null });
							}}
							className="text-[12px] font-medium text-text-3 hover:text-text hover:underline underline-offset-2 px-1"
						>
							Clear filters
						</button>
					)}
					<ExtLink href={d.report_url} className="ml-auto">
						Sales Register
					</ExtLink>
				</div>
				<p className="flex items-center gap-1.5 text-[11.5px] text-text-3">
					<span aria-hidden="true">ⓘ</span>
					The latest invoice above is always the newest, whatever the filter.
				</p>
			</div>

			<div className="px-5 md:px-0">
				<table className="drill-table w-full text-[12.5px] tabular-nums">
					<thead className="bg-[#faf8f2]">
						<tr>
							<DrillTh align="left">
								<span className="md:pl-2">Invoice no</span>
							</DrillTh>
							<DrillTh align="left">Date</DrillTh>
							<DrillTh align="left">Customer</DrillTh>
							<DrillTh>Items</DrillTh>
							<DrillTh>Sale total</DrillTh>
							<DrillTh>COGS total</DrillTh>
							<DrillTh>Margin</DrillTh>
							<th className="hidden md:table-cell border-b border-border w-8" aria-hidden="true" />
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => {
							const ret = Boolean(r.is_return);
							return (
								<tr
									key={r.name}
									tabIndex={0}
									role="button"
									aria-label={`Open ${r.name}`}
									onClick={() => onOpen(r.name)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											onOpen(r.name);
										}
									}}
									className={cn(
										"group border-b border-border cursor-pointer focus:outline-none focus-visible:bg-green-bg",
										ret ? "bg-[#fdf7f7] hover:bg-[#f9ecec]" : "hover:bg-bg",
									)}
								>
									<td className={cn("drill-primary md:pl-5 md:pr-3 py-3 font-semibold whitespace-nowrap", ret ? "text-red" : "text-text group-hover:text-green")}>
										{r.name}
									</td>
									<td data-label="Date" className="md:px-3 py-3 whitespace-nowrap text-text-2">{shortDate(r.posting_date)}</td>
									<td data-label="Customer" className="md:px-3 py-3">
										<span className="font-semibold text-text">{r.customer_name}</span>
										{ret && <span className="ml-2 badge !text-[10px] !py-0 bg-red-bg text-red">Return</span>}
									</td>
									<td data-label="Items" className="md:px-3 py-3 text-right text-text-2 whitespace-nowrap">{formatNumber(r.item_count)}</td>
									<td data-label="Sale total" className={cn("md:px-3 py-3 text-right font-semibold whitespace-nowrap", ret || r.sale_total < 0 ? "text-red" : "text-text")}>
										{rupees(r.sale_total)}
									</td>
									<td data-label="COGS total" className="md:px-3 py-3 text-right text-text-2 whitespace-nowrap">
										{rupees(r.cogs_total)}
										{r.lines_without_cogs > 0 && r.cogs_total != null && (
											<span className="ml-1 text-text-4" title={`${r.lines_without_cogs} line(s) without an incoming rate`}>
												*
											</span>
										)}
									</td>
									<td data-label="Margin" className="md:px-3 py-3 text-right">
										{ret ? (
											<span className="badge !py-0 bg-red-bg text-red">Return</span>
										) : r.cogs_total == null ? (
											r.lines_flagged ? <FlagChip /> : <span className="text-text-4">—</span>
										) : (
											<MarginChip pct={r.margin_pct} />
										)}
										{!ret && r.lines_flagged > 0 && r.cogs_total != null && (
											<span className="ml-1 text-amber cursor-help" title={`${r.lines_flagged} line(s) look mis-valued and are left out. ${FLAG_TITLE}`}>
												⚠
											</span>
										)}
									</td>
									<td className="hidden md:table-cell pr-4 py-3 text-right text-text-4 group-hover:text-text" aria-hidden="true">
										›
									</td>
								</tr>
							);
						})}
						{rows.length === 0 && (
							<tr>
								<td colSpan={8} className="px-5 py-10 text-center">
									<div className="text-[13px] text-text-2">No sales invoices match these filters.</div>
									{filtered && (
										<button
											type="button"
											onClick={() => patch({ range: null, inv_from: null, inv_to: null, q: null, customer: null, group: null, returns: null, start: null })}
											className="mt-3 px-3 py-1.5 text-[11.5px] font-semibold rounded-full bg-green text-white hover:bg-green-mid"
										>
											Show the last 30 days
										</button>
									)}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<div className="px-5 pb-4">
				<Pager start={d.start} pageLength={d.page_length || PAGE} total={d.total_count} onChange={onPage} noun="invoices" />
			</div>
		</section>
	);
}

/* ── dialog ─────────────────────────────────────────────────────────────── */

function InvoiceDialog({
	name,
	taxMode,
	position,
	total,
	onClose,
	onPrev,
	onNext,
}: {
	name: string | null;
	taxMode: TaxMode;
	position: number | null;
	total: number;
	onClose: () => void;
	onPrev?: () => void;
	onNext?: () => void;
}) {
	const { data, error, isLoading } = useInvoiceDetail(name, taxMode);
	// keepPreviousData: the previous invoice stays (dimmed) while the next one loads.
	const showing = data?.message;
	const btn =
		"inline-flex items-center gap-1 min-h-[36px] px-3.5 rounded-[8px] border border-border-md bg-surface text-[12px] font-semibold text-text hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed";

	return (
		<Dialog.Root open={Boolean(name)} onOpenChange={(o) => !o && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-[80] bg-[rgba(26,24,16,.45)]" />
				<Dialog.Content
					aria-describedby={undefined}
					onKeyDown={(e) => {
						if (e.key === "ArrowLeft" && onPrev) onPrev();
						if (e.key === "ArrowRight" && onNext) onNext();
					}}
					className={cn(
						"fixed z-[81] flex flex-col bg-surface outline-none shadow-[0_12px_40px_rgba(40,30,15,.2)]",
						// Phone: full-height bottom sheet. Desktop: centred, 760px.
						"inset-x-0 bottom-0 top-[6vh] rounded-t-[18px]",
						"md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[min(760px,calc(100vw-48px))] md:max-h-[88vh] md:rounded-[12px] md:border md:border-border-md",
					)}
				>
					<div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-border">
						<Dialog.Title className="text-[12px] font-semibold tracking-[0.08em] uppercase text-text-3">Sales invoice</Dialog.Title>
						<div className="flex items-center gap-2">
							{showing && (
								<ExtLink href={showing.url} variant="inline" className="text-[12.5px] font-semibold">
									Open in ERPNext
								</ExtLink>
							)}
							<Dialog.Close className="w-10 h-10 -mr-2 rounded-full flex items-center justify-center text-text-2 hover:bg-surface-2" aria-label="Close">
								<svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
									<path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
								</svg>
							</Dialog.Close>
						</div>
					</div>
					<div className={cn("overflow-y-auto overscroll-contain flex-1", isLoading && showing && "opacity-60 transition-opacity")}>
						{error && !showing ? (
							<div className="p-5">
								<ErrorCard title="Unable to load this invoice" error={error} />
							</div>
						) : showing ? (
							<InvoiceBody inv={showing} taxMode={taxMode} />
						) : (
							<div className="p-5 animate-pulse space-y-3">
								<div className="h-8 w-1/2 bg-surface-2 rounded" />
								<div className="h-10 bg-surface-2 rounded" />
								<div className="h-48 bg-surface-2 rounded" />
							</div>
						)}
					</div>
					<div className="shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t border-border" style={{ paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
						<button type="button" className={btn} onClick={onPrev} disabled={!onPrev}>
							‹ Previous
						</button>
						<span className="text-[11.5px] text-text-3 tabular-nums">
							{position ? `Invoice ${formatNumber(position)} of ${formatNumber(total)}` : ""}
						</span>
						<button type="button" className={btn} onClick={onNext} disabled={!onNext}>
							Next ›
						</button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
