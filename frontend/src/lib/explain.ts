/** "Every number explains itself" — one generic content model shown by <Explain> (hover
 *  popover on desktop, bottom sheet on touch) and reused by the drill pages:
 *  title · value · formula · components[] · sources[] · links[].
 *
 *  Builders for the P&L ladder live here; pages build ad-hoc content (working capital,
 *  SKU rows…) with the same shape. Everything is computed from data already on the page —
 *  opening an explanation never hits the network. */
import { formatINR, formatMargin, formatPct, MINUS } from "@/lib/utils";
import type { ExtraParams } from "@/lib/urlState";
import type { ApiPnlStep, PnlBucket, PnlStepKey } from "@/types/mis";

export interface ExplainRow {
	label: string;
	/** ₹ amount (formatted with formatINR) — or pass `display` for non-₹ values. */
	amount?: number | null;
	display?: string;
	/** Sign column: "+", "−", "=" (or none). */
	sign?: "+" | "−" | "=" | "";
	/** Share of the line, shown as "12.3%". */
	pct?: number | null;
	/** In-app drill page for this row (opens in a new tab). */
	href?: string;
	/** Desk page (ERPNext) for this row (opens in a new tab). */
	deskHref?: string;
	muted?: boolean;
	strong?: boolean;
	note?: string;
}

export interface ExplainLink {
	label: string;
	href: string;
	/** Desk / ERPNext link (styled secondary). */
	desk?: boolean;
}

export interface ExplainCheck {
	ok: boolean;
	text: string;
}

export interface ExplainContent {
	/** Metric name, e.g. "CM2 · Before marketing". */
	title: string;
	/** Period · bucket context line. */
	context?: string;
	/** Headline value as shown on the tile. */
	value: string;
	/** e.g. "30.3% of ex-tax revenue". */
	valueSub?: string;
	/** How the figure is made (symbolic). */
	formula?: string;
	/** The same formula with live values. */
	formulaLive?: string;
	componentsTitle?: string;
	components?: ExplainRow[];
	sourcesTitle?: string;
	sources?: ExplainRow[];
	/** Σ sources / components tie-out. */
	check?: ExplainCheck | null;
	notes?: string[];
	links?: ExplainLink[];
}

/** Context every builder needs: period text, bucket and an href builder. */
export interface ExplainCtx {
	periodLabel: string;
	bucket: PnlBucket;
	/** From useDashState().buildHref. */
	buildHref: (path: string, extra?: ExtraParams) => string;
	/** Desk General Ledger link builder (company + dates). */
	glHref?: (accounts: string[]) => string;
}

export const BUCKET_LABEL: Record<PnlBucket, string> = {
	overall: "Total",
	b2c: "B2C",
	b2b: "B2B",
	unclassified: "Unclassified",
};

/** Ties within ₹1. */
export const TIE_TOLERANCE = 1;

export function signOf(n: number): "+" | "−" {
	return n < 0 ? "−" : "+";
}

/** Sign of a term that is subtracted unless it is a net credit (a zero cost reads "−"). */
export function deductionSign(n: number): "+" | "−" {
	return n > 0 ? "+" : "−";
}

/** "₹1.23 Cr" without the sign (the sign column carries it). */
export function absINR(n: number | null | undefined): string {
	return n == null ? "—" : formatINR(Math.abs(n));
}

/** Href of a line drill page. */
export function lineHref(ctx: Pick<ExplainCtx, "buildHref">, key: PnlStepKey, bucket: PnlBucket): string {
	return ctx.buildHref(`/mis/line/${key}`, { bucket: bucket === "overall" ? null : bucket });
}

/** Href of an account drill page (`from` = the line it was opened from, for crumbs). */
export function accountHref(
	ctx: Pick<ExplainCtx, "buildHref">,
	account: string,
	extra?: ExtraParams,
): string {
	return ctx.buildHref(`/mis/account/${encodeURIComponent(account)}`, extra);
}

/** Desk General Ledger report filtered to accounts + window (mirrors the backend's
 *  gl_report_url). */
export function deskGlHref(company: string, from: string, to: string, accounts: string[]): string {
	const p = new URLSearchParams({ company, from_date: from, to_date: to });
	if (accounts.length) p.set("account", JSON.stringify(accounts));
	p.set("group_by", "Group by Voucher (Consolidated)");
	return `/app/query-report/General%20Ledger?${p.toString()}`;
}

export function deskAccountHref(account: string): string {
	return `/app/account/${encodeURIComponent(account)}`;
}

/** Desk form of a party ("Customer" → /app/customer/<name>). */
export function deskPartyHref(partyType: string | null | undefined, party: string | null | undefined): string | undefined {
	if (!partyType || !party) return undefined;
	return `/app/${partyType.toLowerCase().replace(/\s+/g, "-")}/${encodeURIComponent(party)}`;
}

/** What a step's ledgers must add up to: deductions −amount, anchors amount. */
export function sourcesTarget(step: ApiPnlStep): number {
	return step.kind === "deduction" ? -step.amount : step.amount;
}

export function sum(ns: number[]): number {
	return ns.reduce((a, b) => a + b, 0);
}

export function tieCheck(total: number, target: number, what: string, valueText: string): ExplainCheck {
	const ok = Math.abs(total - target) <= TIE_TOLERANCE;
	return ok
		? { ok, text: `Σ ${what} = ${valueText} ✓` }
		: { ok, text: `Σ ${what} ${formatINR(total)} ≠ ${valueText} (off by ${formatINR(total - target)}) ⚠` };
}

/** Value text of a step as tiles show it (tiers / anchor: running total). */
export function stepValue(step: ApiPnlStep): number {
	return step.kind === "deduction" ? step.amount : step.subtotal;
}

const MAX_SOURCES = 7;

/** Explanation of one P&L step (tier, deduction or revenue anchor). */
export function explainStep(
	step: ApiPnlStep,
	ctx: ExplainCtx,
	opts: { maxSources?: number; title?: string; value?: string; valueSub?: string; notes?: string[] } = {},
): ExplainContent {
	const bucket = ctx.bucket;
	const bucketText = bucket === "overall" ? "" : ` · ${BUCKET_LABEL[bucket]}`;
	const value = stepValue(step);
	const pctText =
		step.kind === "anchor" ? "ex-tax, net of returns" : `${formatMargin(step.pct)} of ex-tax revenue`;
	const out: ExplainContent = {
		title: opts.title ?? step.label,
		context: `${ctx.periodLabel}${bucketText}`,
		value: opts.value ?? formatINR(value),
		valueSub: opts.valueSub ?? pctText,
		formula: step.formula,
		notes: [...(opts.notes ?? [])],
		links: [{ label: "Open breakdown", href: lineHref(ctx, step.key, bucket) }],
	};

	if (step.kind === "tier") {
		const comps = step.components ?? [];
		out.componentsTitle = "Built from";
		out.components = comps.map((c, i) => ({
			label: c.label,
			amount: c.amount,
			sign: i === 0 ? "" : deductionSign(c.amount),
			href: lineHref(ctx, c.key, bucket),
		}));
		out.components.push({ label: step.label, amount: value, sign: "=", strong: true });
		if (comps.length) {
			out.formulaLive =
				comps
					.map((c, i) =>
						i === 0 ? formatINR(c.amount) : `${deductionSign(c.amount)} ${absINR(c.amount)}`,
					)
					.join(" ") + ` = ${formatINR(value)}`;
			out.check = tieCheck(sum(comps.map((c) => c.amount)), value, "parts", formatINR(value));
		}
		return out;
	}

	// Deduction or revenue: the ledgers.
	const sources = [...(step.sources ?? [])].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
	const target = sourcesTarget(step);
	const max = opts.maxSources ?? MAX_SOURCES;
	const top = sources.length > max + 1 ? sources.slice(0, max) : sources;
	const rest = sources.slice(top.length);
	const shareOf = (amt: number) => (Math.abs(target) >= 0.5 ? (amt / target) * 100 : null);
	const isRevenue = step.kind === "anchor";
	const accounts = sources.map((s) => s.account).filter((a): a is string => Boolean(a));

	out.sourcesTitle = isRevenue
		? "Income accounts"
		: `Ledgers${sources.length ? ` (${sources.length})` : ""} · + adds cost, − nets it down`;
	out.sources = top.map((s) => ({
		label: s.account ?? s.label ?? "—",
		amount: s.amount,
		sign: isRevenue ? "" : signOf(s.amount),
		pct: shareOf(s.amount),
		href: s.account
			? accountHref(ctx, s.account, { via: step.key, bucket: bucket === "overall" ? null : bucket })
			: undefined,
		muted: !s.account,
	}));
	if (rest.length) {
		const restAmt = sum(rest.map((r) => r.amount));
		out.sources.push({
			label: `Others (${rest.length})`,
			amount: restAmt,
			sign: isRevenue ? "" : signOf(restAmt),
			pct: shareOf(restAmt),
			href: lineHref(ctx, step.key, bucket),
			muted: true,
		});
	}
	if (!sources.length) out.notes!.push("No ledger is mapped to this line, or none moved in the period.");
	out.check = tieCheck(
		sum(sources.map((s) => s.amount)),
		target,
		isRevenue ? "accounts" : "ledgers",
		formatINR(target),
	);
	out.formulaLive = `Σ ${sources.length} ${sources.length === 1 ? "ledger" : "ledgers"} = ${formatINR(target)}${
		step.kind === "deduction" ? ` → line ${formatINR(step.amount)}` : ""
	}`;

	if (step.key === "cogs" && step.split) {
		out.notes!.push(
			`Split for buckets: stock-ledger cost of invoice lines ${formatINR(step.split.allocated)} + unallocated (GL − stock ledger) ${formatINR(step.split.unallocated)}.`,
		);
	}
	if (bucket !== "overall" && step.share != null && !isRevenue) {
		out.notes!.push(
			`GL accounts × ${formatPct(step.share * 100)} revenue share — ledger amounts here are this bucket's share; the account page shows the full GL amount.`,
		);
	}
	if (isRevenue) {
		out.links!.push({
			label: "Invoices",
			href: ctx.buildHref("/mis/revenue", { bucket: bucket === "overall" ? null : bucket }),
		});
	}
	if (accounts.length && ctx.glHref) {
		out.links!.push({ label: "Open in ERPNext GL", href: ctx.glHref(accounts), desk: true });
	}
	return out;
}

/** Several steps summed into one figure (e.g. Operating opex = salary + rent + …). */
export function explainComposite(
	title: string,
	steps: ApiPnlStep[],
	ctx: ExplainCtx,
	opts: { expected?: number; formula?: string; valueSub?: string; notes?: string[] } = {},
): ExplainContent {
	// Deductions are negative; the composite reads as a positive cost.
	const parts = steps.map((s) => -s.amount);
	const total = sum(parts);
	const expected = opts.expected ?? total;
	const accounts = steps.flatMap((s) => (s.sources ?? []).map((x) => x.account)).filter((a): a is string => !!a);
	return {
		title,
		context: `${ctx.periodLabel}${ctx.bucket === "overall" ? "" : ` · ${BUCKET_LABEL[ctx.bucket]}`}`,
		value: formatINR(expected),
		valueSub: opts.valueSub,
		formula: opts.formula ?? steps.map((s) => s.label).join(" + "),
		formulaLive: parts.map((p, i) => (i === 0 ? formatINR(p) : `${p < 0 ? MINUS : "+"} ${absINR(p)}`)).join(" ") + ` = ${formatINR(total)}`,
		componentsTitle: "Built from",
		components: [
			...steps.map((s, i) => ({
				label: s.label,
				amount: -s.amount,
				sign: (i === 0 ? "" : signOf(-s.amount)) as ExplainRow["sign"],
				href: lineHref(ctx, s.key, ctx.bucket),
				note: `${(s.sources ?? []).length} ledgers`,
			})),
			{ label: title, amount: total, sign: "=", strong: true },
		],
		check: tieCheck(total, expected, "parts", formatINR(expected)),
		notes: opts.notes,
		links: accounts.length && ctx.glHref ? [{ label: "Open in ERPNext GL", href: ctx.glHref(accounts), desk: true }] : [],
	};
}

/** Short accessible name: "CM1, ₹14.30 Cr, 30.4% of ex-tax revenue, has breakdown". */
export function explainAriaLabel(c: ExplainContent): string {
	return [c.title, c.value, c.valueSub, "has breakdown"].filter(Boolean).join(", ");
}

/* ── SKU / segment rows (built from row fields) ─────────────────────────── */

export interface SkuLike {
	item_code: string;
	item_name: string;
	revenue_excl: number;
	cogs: number;
	gp: number;
	gm_pct: number | null;
	cost_coverage_pct?: number | null;
	flagged_lines?: number;
	flagged_cost?: number;
	alloc_freight: number;
	alloc_packaging: number;
	alloc_commission: number;
	alloc_scheme: number;
	alloc_marketing: number;
	cm2: number;
	cm2_pct: number | null;
	cm3: number;
	cm3_pct: number | null;
}

/** GM / CM2 / CM3 of one SKU row: rev ex-tax − stock cost = GP, − allocations = CM2 / CM3. */
export function explainSku(
	r: SkuLike,
	level: "gm" | "cm2" | "cm3",
	opts: { periodLabel: string; basis?: string; itemHref?: string },
): ExplainContent {
	const rows: ExplainRow[] = [
		{ label: "Revenue (ex-tax)", amount: r.revenue_excl, sign: "" },
		{ label: "Stock-ledger cost", amount: r.cogs, sign: "−" },
		{ label: "Gross profit", amount: r.gp, sign: "=", strong: level === "gm" },
	];
	let value = r.gp;
	let pct = r.gm_pct;
	let formula = "Revenue ex-tax − stock-ledger cost of the invoice lines";
	let parts = [r.revenue_excl, -r.cogs];
	if (level !== "gm") {
		rows.push(
			{ label: "Freight (allocated)", amount: r.alloc_freight, sign: "−" },
			{ label: "Packaging (allocated)", amount: r.alloc_packaging, sign: "−" },
			{ label: "Transaction fees (allocated)", amount: r.alloc_commission, sign: "−" },
			{ label: "Trade schemes (allocated)", amount: r.alloc_scheme, sign: "−" },
			{ label: "CM2", amount: r.cm2, sign: "=", strong: level === "cm2" },
		);
		value = r.cm2;
		pct = r.cm2_pct;
		formula = "GP − allocated freight − packaging − transaction fees − schemes";
		parts = [r.gp, -r.alloc_freight, -r.alloc_packaging, -r.alloc_commission, -r.alloc_scheme];
	}
	if (level === "cm3") {
		rows.push(
			{ label: "Marketing (allocated)", amount: r.alloc_marketing, sign: "−" },
			{ label: "CM3", amount: r.cm3, sign: "=", strong: true },
		);
		value = r.cm3;
		pct = r.cm3_pct;
		formula = "CM2 − allocated marketing";
		parts = [r.cm2, -r.alloc_marketing];
	}
	const total = sum(parts);
	const notes: string[] = [];
	if (level !== "gm") notes.push(`Variable costs and marketing are allocated by ex-tax revenue share${opts.basis ? ` (${opts.basis})` : ""}.`);
	notes.push("Unallocated cost of goods and direct costs are not spread to SKUs — they're a separate line in the totals.");
	if (r.cost_coverage_pct != null) notes.push(`${formatPct(r.cost_coverage_pct, 0)} of this SKU's revenue has a stock-ledger cost.`);
	if (r.flagged_lines) notes.push(`${r.flagged_lines} flagged line(s) with impossible cost (${formatINR(r.flagged_cost ?? 0)}) are kept out of the cost.`);
	return {
		title: `${level === "gm" ? "Gross margin" : level.toUpperCase()} · ${r.item_code}`,
		context: `${opts.periodLabel} · ${r.item_name}`,
		value: formatMargin(pct),
		valueSub: `${formatINR(value)} on ${formatINR(r.revenue_excl)} ex-tax revenue`,
		formula,
		formulaLive: parts.map((p, i) => (i === 0 ? formatINR(p) : `${p < 0 ? MINUS : "+"} ${absINR(p)}`)).join(" ") + ` = ${formatINR(total)}`,
		componentsTitle: "Built from",
		components: rows,
		check: tieCheck(total, value, "parts", formatINR(value)),
		notes,
		links: opts.itemHref ? [{ label: "Item in ERPNext", href: opts.itemHref, desk: true }] : [],
	};
}

/** GM of a customer segment: revenue ex-tax − stock-ledger cost = GP. */
export function explainSegmentGm(
	s: { segment: string; revenue_excl: number; cogs: number; gp: number; gm_pct: number | null; gm_coverage_pct: number | null },
	periodLabel: string,
): ExplainContent {
	const total = s.revenue_excl - s.cogs;
	return {
		title: `Gross margin · ${s.segment}`,
		context: periodLabel,
		value: formatMargin(s.gm_pct),
		valueSub: `GP ${formatINR(s.gp)} on ${formatINR(s.revenue_excl)} ex-tax revenue`,
		formula: "Revenue ex-tax − stock-ledger cost of the segment's invoice lines",
		formulaLive: `${formatINR(s.revenue_excl)} − ${absINR(s.cogs)} = ${formatINR(total)}`,
		components: [
			{ label: "Revenue (ex-tax)", amount: s.revenue_excl, sign: "" },
			{ label: "Stock-ledger cost", amount: s.cogs, sign: "−" },
			{ label: "Gross profit", amount: s.gp, sign: "=", strong: true },
		],
		check: tieCheck(total, s.gp, "parts", formatINR(s.gp)),
		notes: [
			s.gm_coverage_pct == null ? "" : `${formatPct(s.gm_coverage_pct, 0)} of the revenue has a stock-ledger cost.`,
			"Unallocated cost of goods is not spread to segments — it's the adjustment line in the totals.",
		].filter(Boolean),
	};
}
