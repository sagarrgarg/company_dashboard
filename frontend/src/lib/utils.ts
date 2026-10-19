import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { PeriodInfo, PeriodSelection } from "@/types/mis";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Unicode minus — used for every negative number on screen. */
export const MINUS = "−";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const IN_2DP = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const IN_0DP = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The one INR formatter (en-IN):
 *  - sign first: "−₹1.23 Cr"
 *  - rounds BEFORE choosing the unit (99,99,600 → "₹1.00 Cr", ₹99.95 L stays "₹99.95 L")
 *  - crores "₹12.34 Cr" (en-IN grouping ≥ 1,000 Cr), lakhs "₹12.34 L", below a lakh "₹12,345"
 *  - "—" for null / undefined / NaN / ±Infinity. */
export function formatINR(value: number | null | undefined): string {
	if (!isNum(value)) return "—";
	const abs = Math.abs(value);
	let body: string;
	const rupees = Math.round(abs);
	if (rupees < 1_00_000) {
		body = `₹${IN_0DP.format(rupees)}`;
	} else {
		const lakhs = round2(abs / 1_00_000);
		if (lakhs < 100) body = `₹${IN_2DP.format(lakhs)} L`;
		else body = `₹${IN_2DP.format(round2(abs / 1_00_00_000))} Cr`;
	}
	const isZero = rupees === 0;
	return value < 0 && !isZero ? `${MINUS}${body}` : body;
}

/** Plain count / quantity with en-IN grouping. */
export function formatNumber(value: number | null | undefined, digits = 0): string {
	if (!isNum(value)) return "—";
	const s = new Intl.NumberFormat("en-IN", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(Math.abs(value));
	const zero = Number(Math.abs(value).toFixed(digits)) === 0;
	return value < 0 && !zero ? `${MINUS}${s}` : s;
}

export function formatPct(value: number | null | undefined, digits = 1): string {
	if (!isNum(value)) return "—";
	const s = Math.abs(value).toFixed(digits);
	const zero = Number(s) === 0;
	return `${value < 0 && !zero ? MINUS : ""}${s}%`;
}

/* ── Margins (F1 / F11) ──────────────────────────────────────────────────── */

/** |margin| above this is not a real margin — it's a stock-valuation data issue. */
export const MARGIN_LIMIT = 100;

export type MarginState = "ok" | "na" | "bogus";

/** null pct → "na" (revenue below the ₹1,000 floor); |pct| > 100 → "bogus". */
export function marginState(pct: number | null | undefined): MarginState {
	if (!isNum(pct)) return "na";
	if (Math.abs(pct) > MARGIN_LIMIT) return "bogus";
	return "ok";
}

export const MARGIN_NA_TITLE = "Not meaningful: revenue below ₹1,000 for this period.";
export const MARGIN_BOGUS_TITLE =
	"Not shown: margin beyond ±100% of revenue — almost always a stock-valuation error. See the data-issue banner.";

/** Margin text: "12.3%", "n/a" (below revenue floor) or "n/a ⚠" (impossible margin). */
export function formatMargin(pct: number | null | undefined, digits = 1): string {
	const st = marginState(pct);
	if (st === "na") return "n/a";
	if (st === "bogus") return "n/a ⚠";
	return formatPct(pct, digits);
}

export function marginTitle(pct: number | null | undefined): string | undefined {
	const st = marginState(pct);
	if (st === "na") return MARGIN_NA_TITLE;
	if (st === "bogus") return `${MARGIN_BOGUS_TITLE} (computed ${formatPct(pct)})`;
	return undefined;
}

/** True when a cost line exceeds 2× its revenue (F1 trigger). */
export function costExceedsRevenue(cost: number, revenue: number): boolean {
	if (!isNum(cost) || !isNum(revenue)) return false;
	return Math.abs(cost) > 2 * Math.abs(revenue) && Math.abs(cost) >= 500;
}

/* ── Growth (F2 / F15) ───────────────────────────────────────────────────── */

export interface Delta {
	label: string;
	direction: "up" | "down" | "flat";
	/** Set when the comparison isn't fair (prior period incomplete). */
	unavailable?: boolean;
}

export const PRIOR_INCOMPLETE = "n/a (prior period incomplete)";

/** Round first, then pick the arrow — so −0.3% renders "0%", never "↓0%". */
export function formatDelta(value: number | null | undefined): Delta {
	if (!isNum(value)) return { label: "—", direction: "flat" };
	const r = Math.round(value);
	if (r > 0) return { label: `↑${r}%`, direction: "up" };
	if (r < 0) return { label: `↓${Math.abs(r)}%`, direction: "down" };
	return { label: "0%", direction: "flat" };
}

/** Growth vs the prior window — "n/a (prior period incomplete)" unless the API says the
 *  prior window is fully covered. */
export function growthDelta(
	current: number | null | undefined,
	prior: number | null | undefined,
	priorAvailable: boolean,
): Delta {
	if (!priorAvailable) return { label: PRIOR_INCOMPLETE, direction: "flat", unavailable: true };
	if (!isNum(current) || !isNum(prior) || prior === 0) return { label: "—", direction: "flat" };
	return formatDelta(((current - prior) / Math.abs(prior)) * 100);
}

/* ── Revenue mix (F5) ────────────────────────────────────────────────────── */

/** Share of each part in the total, rounded once — the donut and the tiles both use this. */
export function mixShares<K extends string>(parts: Record<K, number>, total: number): Record<K, number | null> {
	const out = {} as Record<K, number | null>;
	for (const k of Object.keys(parts) as K[]) {
		out[k] = total ? Math.round((parts[k] / total) * 100) : null;
	}
	return out;
}

/* ── Months (F16) ────────────────────────────────────────────────────────── */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-04" → "Apr '25". */
export function monthLabel(key: string): string {
	const [y, m] = key.split("-");
	const name = MONTHS[Number(m) - 1] ?? m;
	return y ? `${name} '${y.slice(-2)}` : name;
}

function daysInMonth(y: number, m: number): number {
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Month keys of the period that are not complete: a first month that starts after the
 *  1st, and a last month that ends before month end (month-to-date). */
export function partialMonthKeys(period: Pick<PeriodInfo, "from" | "to">): Set<string> {
	const out = new Set<string>();
	const fd = Number(period.from.split("-")[2]);
	const [ty, tm, td] = period.to.split("-").map(Number);
	if (fd && fd !== 1) out.add(period.from.slice(0, 7));
	if (td && td !== daysInMonth(ty, tm)) out.add(period.to.slice(0, 7));
	return out;
}

/* ── Period text (F7) ────────────────────────────────────────────────────── */

function shortDate(iso: string): string {
	if (!iso) return "";
	const [y, m, d] = iso.split("-");
	return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** Label for the picker / sidebar from the local selection (before the API answers). */
export function describePeriod(p: PeriodSelection): string {
	if (p.kind === "ttm") return "Last 12 months";
	if (p.kind === "fy") return `FY ${p.name}`;
	return `${shortDate(p.from)} – ${shortDate(p.to)}`;
}

export { shortDate };

/** Short in-sentence period name from the API, e.g. "last 12 months", "FY 2026-2027". */
export function periodShort(p: PeriodInfo): string {
	if (p.kind === "ttm") return "last 12 months";
	if (p.kind === "fy") return p.label;
	return "selected period";
}

/* ── Errors (F12) ────────────────────────────────────────────────────────── */

function stripHtml(s: string): string {
	return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

/** Real message from a frappe-js-sdk error: _server_messages → exception → message. */
export function errorMessage(err: unknown): string {
	if (!err) return "Unknown error";
	if (typeof err === "string") return err;
	const e = err as {
		_server_messages?: string;
		exception?: string;
		message?: string;
		httpStatus?: number;
		httpStatusText?: string;
	};
	if (e._server_messages) {
		try {
			const msgs = (JSON.parse(e._server_messages) as string[])
				.map((m) => {
					try {
						const parsed = JSON.parse(m) as { message?: string };
						return parsed.message ?? m;
					} catch {
						return m;
					}
				})
				.map(stripHtml)
				.filter(Boolean);
			if (msgs.length) return msgs.join(" · ");
		} catch {
			/* fall through */
		}
	}
	if (e.exception) {
		return stripHtml(e.exception.replace(/^[\w.]+(Error|Exception)\s*:\s*/, ""));
	}
	if (e.message && e.message !== "There was an error.") return stripHtml(e.message);
	if (e.httpStatus) return `${e.httpStatus} ${e.httpStatusText ?? ""}`.trim();
	return e.message ?? "Unknown error";
}

/* ── Server time (F13) ───────────────────────────────────────────────────── */

function tzOffsetMs(tz: string, utcMs: number): number {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts: Record<string, number> = {};
	for (const p of dtf.formatToParts(new Date(utcMs))) {
		if (p.type !== "literal") parts[p.type] = Number(p.value);
	}
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
	return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Epoch ms of a naive server-local ISO timestamp ("2026-10-19T19:06:21.79"), interpreted
 *  in the given IANA zone. Falls back to browser-local parsing when no zone is known. */
export function parseServerTime(naive: string, tz: string | undefined): number {
	if (/[zZ]|[+-]\d\d:?\d\d$/.test(naive)) return new Date(naive).getTime();
	const m = naive.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.(\d+))?/);
	if (!m || !tz) return new Date(naive).getTime();
	const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
	const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
	try {
		let guess = wall - tzOffsetMs(tz, wall);
		guess = wall - tzOffsetMs(tz, guess); // second pass settles DST edges
		return guess;
	} catch {
		return new Date(naive).getTime();
	}
}

/* ── Days (F9) ───────────────────────────────────────────────────────────── */

/** Day ratios (DSO/DPO/DIO, days of cash): null or negative → "n/a". The cash
 *  conversion cycle may legitimately be negative — pass allowNegative for it. */
export function formatDays(v: number | null | undefined, allowNegative = false): string {
	if (!isNum(v) || (!allowNegative && v < 0)) return "n/a";
	const r = Math.round(v);
	return `${r < 0 ? MINUS : ""}${Math.abs(r)} days`;
}
