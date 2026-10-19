/** <Explain> builders for the statement pages (P&L statement, balance sheet, cash flow,
 *  ratios, controls, alerts). Same content model as lib/explain.ts; everything comes from
 *  the payload already on the page. */
import {
	absINR,
	deskAccountHref,
	signOf,
	sum,
	tieCheck,
	TIE_TOLERANCE,
	type ExplainContent,
	type ExplainRow,
} from "@/lib/explain";
import type { ExtraParams } from "@/lib/urlState";
import { formatINR, formatMargin, formatNumber, formatPct, MINUS, shortDate } from "@/lib/utils";
import type {
	Alert,
	BalanceSheetResponse,
	BsColumn,
	BsRow,
	BsSection,
	CashFlowResponse,
	CashFlowRow,
	CashFlowSection,
	ControlCheck,
	PnlStatementResponse,
	Ratio,
	StatementMonth,
	StatementRow,
} from "@/types/finance";
import type { PeriodInfo } from "@/types/mis";

export type BuildHref = (path: string, extra?: ExtraParams) => string;

/* ── Windows ────────────────────────────────────────────────────────────── */

/** URL params that pin the dashboard period to a custom window (drill in a new tab). */
export function windowExtra(from: string, to: string, extra?: ExtraParams): ExtraParams {
	return { period: "custom", fy: null, from, to, ...extra };
}

function lastDay(ym: string): string {
	const [y, m] = ym.split("-").map(Number);
	const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
	return `${ym}-${String(d).padStart(2, "0")}`;
}

/** Calendar bounds of a statement month, clipped to the period (partial first / last month). */
export function monthWindow(ym: string, period: Pick<PeriodInfo, "from" | "to">): { from: string; to: string } {
	const from = `${ym}-01` < period.from ? period.from : `${ym}-01`;
	const end = lastDay(ym);
	return { from, to: end > period.to ? period.to : end };
}

/** Account drill with balance-sheet semantics: opening at FY start, closing on the as-of. */
export function bsAccountHref(buildHref: BuildHref, account: string, fyStart: string, asOf: string): string {
	return buildHref(`/mis/account/${encodeURIComponent(account)}`, windowExtra(fyStart, asOf, { via: "bs" }));
}

/** "1.34x" / "80.3%" / "n/a". */
export function formatRatio(r: Pick<Ratio, "unit">, v: number | null | undefined): string {
	if (v == null || !Number.isFinite(v)) return "n/a";
	return r.unit === "%" ? formatPct(v) : `${formatNumber(v, 2)}x`;
}

const sorted = <T extends { amount: number }>(xs: T[]) => [...xs].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

/** Top-N rows + an "Others (n)" summary row so a popover stays readable. */
function capRows(rows: ExplainRow[], max: number, othersNote?: string): ExplainRow[] {
	if (rows.length <= max + 1) return rows;
	const top = rows.slice(0, max);
	const rest = rows.slice(max);
	const amt = sum(rest.map((r) => r.amount ?? 0));
	return [...top, { label: `Others (${rest.length})`, amount: amt, muted: true, note: othersNote }];
}

/* ── P&L statement ──────────────────────────────────────────────────────── */

export type StatementColumn = { kind: "month"; month: StatementMonth } | { kind: "total" } | { kind: "prior" } | { kind: "change" };

/** The rows a tier is built from: the tier (or revenue) above it + the deductions between. */
export function tierParts(rows: StatementRow[], i: number): StatementRow[] {
	const parts: StatementRow[] = [];
	for (let j = i - 1; j >= 0; j--) {
		parts.unshift(rows[j]);
		if (rows[j].kind !== "deduction") break;
	}
	return parts;
}

function valueAt(r: StatementRow, col: StatementColumn): number | null {
	if (col.kind === "month") return r.values[col.month.key] ?? 0;
	if (col.kind === "total") return r.total;
	if (col.kind === "prior") return r.prior_total ?? null;
	return r.change ?? null;
}

export function statementCellHref(
	buildHref: BuildHref,
	r: StatementRow,
	col: StatementColumn,
	st: PnlStatementResponse,
): string | undefined {
	if (col.kind === "month") {
		const w = monthWindow(col.month.key, st.period);
		return buildHref(`/mis/line/${r.key}`, windowExtra(w.from, w.to));
	}
	if (col.kind === "prior") return buildHref(`/mis/line/${r.key}`, windowExtra(st.period.prior.from, st.period.prior.to));
	return buildHref(`/mis/line/${r.key}`);
}

export function explainStatementCell(
	st: PnlStatementResponse,
	i: number,
	col: StatementColumn,
	buildHref: BuildHref,
): ExplainContent {
	const r = st.rows[i];
	const v = valueAt(r, col);
	const isDed = r.kind === "deduction";
	const ctxLabel =
		col.kind === "month"
			? `${col.month.label}${col.month.partial ? " · partial month" : ""} · ex-tax`
			: col.kind === "total"
				? `${st.period.label} · ex-tax`
				: col.kind === "prior"
					? `Prior year · ${shortDate(st.period.prior.from)} – ${shortDate(st.period.prior.to)}`
					: `${st.period.comparison_label}`;
	const pct =
		col.kind === "month" ? r.pct[col.month.key] : col.kind === "total" ? r.total_pct : null;
	const out: ExplainContent = {
		title: col.kind === "change" ? `${r.label} · change` : r.label,
		context: ctxLabel,
		value: formatINR(v),
		valueSub:
			col.kind === "change"
				? r.change_pct == null
					? undefined
					: `${formatPct(r.change_pct)} vs prior year`
				: r.kind === "anchor"
					? "ex-tax, net of returns"
					: pct == null
						? undefined
						: `${formatMargin(pct)} of revenue`,
		formula: r.formula,
		notes: [],
		links: [],
	};
	const href = statementCellHref(buildHref, r, col, st);

	if (col.kind === "change") {
		const total = r.total;
		const prior = r.prior_total ?? 0;
		out.formula = "This period − same period last year (higher is better: a cost that shrinks is a gain)";
		out.formulaLive = `${formatINR(total)} − ${formatINR(prior)} = ${formatINR(total - prior)}`;
		out.components = [
			{ label: "This period", amount: total, sign: "" },
			{ label: "Prior year", amount: prior, sign: "−" },
			{ label: "Change", amount: r.change ?? total - prior, sign: "=", strong: true },
		];
		out.links = [{ label: "This period's breakdown", href: buildHref(`/mis/line/${r.key}`) }];
		return out;
	}

	if (r.kind === "tier") {
		const parts = tierParts(st.rows, i);
		const vals = parts.map((p) => valueAt(p, col) ?? 0);
		out.componentsTitle = "Built from";
		out.components = [
			...parts.map((p, k) => ({
				label: p.label,
				amount: vals[k],
				sign: (k === 0 ? "" : signOf(vals[k])) as ExplainRow["sign"],
				href: statementCellHref(buildHref, p, col, st),
			})),
			{ label: r.label, amount: v ?? 0, sign: "=", strong: true },
		];
		out.formulaLive =
			vals.map((x, k) => (k === 0 ? formatINR(x) : `${x < 0 ? MINUS : "+"} ${absINR(x)}`)).join(" ") + ` = ${formatINR(v)}`;
		out.check = tieCheck(sum(vals), v ?? 0, "parts", formatINR(v));
	} else if (isDed) {
		out.notes!.push("Deductions are negative; a positive figure is a net credit (it adds to profit).");
	}

	if (col.kind === "total") {
		const months = sum(st.months.map((m) => r.values[m.key] ?? 0));
		out.check = tieCheck(months, r.total, `${st.months.length} months`, formatINR(r.total));
		if (r.key === "pat") {
			const ok = st.checks.pat_equals_gl;
			out.notes!.push(
				`PAT ${formatINR(st.checks.pat)} vs GL net profit ${formatINR(st.checks.gl_net_profit)} ${ok ? "✓ ties" : "⚠ differs"}.`,
			);
		}
		if (r.prior_total != null) out.notes!.push(`Prior year ${formatINR(r.prior_total)}.`);
	}

	if (col.kind === "month" && col.month.partial) {
		out.notes!.push("Partial month — only the days inside the selected period are counted.");
	}

	const where =
		col.kind === "month" ? col.month.label : col.kind === "prior" ? "prior year" : "whole period";
	if (href) out.links!.push({ label: `${r.kind === "deduction" ? "Ledgers" : "Breakdown"} · ${where}`, href });
	if (r.key === "revenue" && col.kind === "month") {
		const w = monthWindow(col.month.key, st.period);
		out.links!.push({ label: `Invoices · ${col.month.label}`, href: buildHref("/mis/revenue", windowExtra(w.from, w.to)) });
	}
	return out;
}

export function explainStatementChecks(st: PnlStatementResponse): ExplainContent {
	const c = st.checks;
	return {
		title: "Statement proof",
		context: `${st.period.label} · ex-tax`,
		value: c.months_sum_to_total && c.pat_equals_gl ? "✓ ties" : "⚠ check",
		formula: "Every row's months add up to its total; PAT equals the GL net profit (Σ income − Σ expense accounts)",
		components: [
			{ label: "PAT (statement)", amount: c.pat, sign: "" },
			{ label: "GL net profit", amount: c.gl_net_profit, sign: "−" },
			{ label: "Difference", amount: c.pat - c.gl_net_profit, sign: "=", strong: true },
		],
		check: { ok: c.pat_equals_gl, text: c.pat_equals_gl ? "PAT = GL net profit ✓" : "PAT ≠ GL net profit ⚠" },
		notes: [
			c.months_sum_to_total
				? `Months sum to the totals ✓ (largest drift ${formatINR(c.max_drift ?? 0)}).`
				: `⚠ Months don't sum to the total (largest drift ${formatINR(c.max_drift ?? 0)}).`,
		],
	};
}

/* ── Balance sheet ──────────────────────────────────────────────────────── */

const LIAB_NOTE = "Equity & liabilities are credit balances; a negative figure here is a net debit balance (e.g. a loan account that's been over-repaid or an advance given).";

export function bsExplainLine(
	bs: BalanceSheetResponse,
	section: BsSection,
	row: BsRow,
	col: BsColumn,
	buildHref: BuildHref,
): ExplainContent {
	const v = row.values[col.key];
	const liab = section.side === "equity_liabilities";
	const out: ExplainContent = {
		title: row.label,
		context: `${section.label} · ${col.label}`,
		value: formatINR(v),
		valueSub: liab ? (v < 0 ? "net debit balance" : "credit balance") : v < 0 ? "net credit balance" : "debit balance",
		notes: [],
		links: [],
	};
	if (v < 0) out.notes!.push(liab ? LIAB_NOTE : "Assets are debit balances; a negative figure is a net credit balance.");

	if (col.key === "as_of") {
		const accts = sorted(row.accounts);
		const derived = accts.some((a) => a.account === null);
		out.formula = derived
			? "Income − expense not yet moved to reserves by a Period Closing Voucher"
			: `Σ ${accts.length} account${accts.length === 1 ? "" : "s"} placed on this line (rule in grey)`;
		out.sourcesTitle = derived ? "Made of" : `Accounts (${accts.length})`;
		out.sources = capRows(
			accts.map((a) =>
				a.account === null
					? { label: a.label, amount: a.amount, muted: false }
					: {
							label: a.account,
							amount: a.amount,
							note: a.rule,
							pct: Math.abs(v) >= 0.5 ? (a.amount / v) * 100 : null,
							href: bsAccountHref(buildHref, a.account, bs.provisional.fy_start, bs.as_of),
						},
			),
			14,
			"expand the line for all",
		);
		out.check = accts.length ? tieCheck(sum(accts.map((a) => a.amount)), v, "accounts", formatINR(v)) : null;
		if (!accts.length) out.notes!.push("No account balance on this line as of this date.");
		if (!derived && accts.length)
			out.notes!.push(
				`Account pages open at ${shortDate(bs.provisional.fy_start)} (FY start) and close on ${shortDate(bs.as_of)}; they show debit − credit, so credit balances read negative there.`,
			);
		if (row.key === "current_pl") {
			const p = bs.provisional;
			out.notes!.push(
				`Current FY profit from ${shortDate(p.fy_start)}: ${formatINR(p.current_fy)}. Earlier fiscal years not closed by a Period Closing Voucher: ${formatINR(p.prior_unclosed)}.`,
			);
			if (!bs.checks.prior_years_closed)
				out.notes!.push("⚠ An earlier year is still open — post its Period Closing Voucher to move it to reserves.");
			out.links!.push({
				label: "P&L statement · this FY",
				href: buildHref("/mis/statement", windowExtra(p.fy_start, bs.as_of)),
			});
		}
	} else {
		out.formula = `Balance on ${shortDate(col.date)}`;
		out.notes!.push("Accounts are listed for the as-of column — open the balance sheet as of this date to see them.");
		out.links!.push({ label: `Balance sheet as of ${shortDate(col.date)}`, href: buildHref("/mis/balance-sheet", { as_of: col.date }) });
	}
	if (row.cash_flow && row.cash_flow !== "cash") {
		out.notes!.push(`Its movement lands in cash flow from ${row.cash_flow} activities.`);
		out.links!.push({ label: "Cash flow", href: buildHref("/mis/cash-flow") });
	}
	return out;
}

export function bsExplainChange(bs: BalanceSheetResponse, section: BsSection, row: BsRow): ExplainContent {
	const fy = bs.columns.find((c) => c.key === "last_fy_close");
	const now = row.values.as_of;
	const then = row.values.last_fy_close;
	return {
		title: `${row.label} · change`,
		context: `${section.label} · since ${fy?.label ?? "last FY close"}`,
		value: formatINR(row.change),
		formula: "As of − last FY close",
		formulaLive: `${formatINR(now)} − ${formatINR(then)} = ${formatINR(now - then)}`,
		components: [
			{ label: `As of ${shortDate(bs.as_of)}`, amount: now, sign: "" },
			{ label: fy?.label ?? "Last FY close", amount: then, sign: "−" },
			{ label: "Change", amount: row.change, sign: "=", strong: true },
		],
		check: tieCheck(now - then, row.change, "parts", formatINR(row.change)),
	};
}

export function bsExplainSection(section: BsSection, col: BsColumn): ExplainContent {
	const lines = section.rows.map((r) => r.values[col.key]);
	const total = section.totals[col.key];
	return {
		title: `Total ${section.label.toLowerCase()}`,
		context: col.label,
		value: formatINR(total),
		formula: section.rows.map((r) => r.label).join(" + ") || "No lines",
		componentsTitle: "Lines",
		components: [
			...section.rows.map((r, k) => ({
				label: r.label,
				amount: r.values[col.key],
				sign: (k === 0 ? "" : signOf(r.values[col.key])) as ExplainRow["sign"],
			})),
			{ label: "Total", amount: total, sign: "=", strong: true },
		],
		check: tieCheck(sum(lines), total, "lines", formatINR(total)),
	};
}

export function bsExplainSide(bs: BalanceSheetResponse, side: "assets" | "equity_liabilities", col: BsColumn): ExplainContent {
	const secs = bs.sections.filter((s) => s.side === side);
	const t = bs.totals[col.key];
	const total = side === "assets" ? t.assets : t.equity_liabilities;
	const other = side === "assets" ? t.equity_liabilities : t.assets;
	const ok = Math.abs(t.difference) <= TIE_TOLERANCE;
	return {
		title: side === "assets" ? "Total assets" : "Total equity & liabilities",
		context: col.label,
		value: formatINR(total),
		formula: secs.map((s) => s.label).join(" + "),
		components: [
			...secs.map((s, k) => ({ label: s.label, amount: s.totals[col.key], sign: (k === 0 ? "" : signOf(s.totals[col.key])) as ExplainRow["sign"] })),
			{ label: "Total", amount: total, sign: "=", strong: true },
		],
		check: {
			ok,
			text: ok
				? `Assets = equity + liabilities ✓ (${formatINR(other)})`
				: `Off by ${formatINR(t.difference)} vs ${side === "assets" ? "equity + liabilities" : "assets"} ⚠`,
		},
	};
}

/* ── Cash flow ──────────────────────────────────────────────────────────── */

const CF_DERIVED: Record<string, { note: string; line?: string }> = {
	pat: { note: "Profit after tax from the P&L (= GL net profit) — the starting point of the indirect method.", line: "pat" },
	finance_cost: { note: "Non-operating: finance cost is added back here and shown as paid under financing (Ind AS 7).", line: "interest" },
	interest_income: { note: "Non-operating: interest income is taken out here and shown as received under investing.", line: "other" },
	interest_received: { note: "Interest income from the P&L, accrual used as received." },
	interest_paid: { note: "Interest & finance cost from the P&L, accrual used as paid.", line: "interest" },
};

export function cfExplainRow(cf: CashFlowResponse, section: CashFlowSection, row: CashFlowRow, buildHref: BuildHref): ExplainContent {
	const out: ExplainContent = {
		title: row.label,
		context: `${section.label} · ${cf.period.label}`,
		value: formatINR(row.amount),
		valueSub: row.amount >= 0 ? "cash in" : "cash out",
		notes: [],
		links: [],
	};
	if (row.accounts.length) {
		const accts = sorted(row.accounts);
		out.formula = "Σ balance movements over the period, cash effect (+ in · − out): an asset that grows uses cash, a liability that grows provides it";
		out.sourcesTitle = `Accounts (${accts.length})`;
		out.sources = capRows(
			accts.map((a) => ({
				label: a.account,
				amount: a.amount,
				sign: signOf(a.amount),
				pct: Math.abs(row.amount) >= 0.5 ? (a.amount / row.amount) * 100 : null,
				href: buildHref(`/mis/account/${encodeURIComponent(a.account)}`, { via: "cf" }),
			})),
			14,
		);
		out.check = tieCheck(sum(accts.map((a) => a.amount)), row.amount, "accounts", formatINR(row.amount));
		out.notes!.push("Account pages show the same period's movement as debit − credit; the cash effect is its opposite (a debit uses cash).");
	} else {
		const d = CF_DERIVED[row.key];
		out.formula = d?.note ?? "Derived from the P&L.";
		if (d?.line) out.links!.push({ label: "P&L line", href: buildHref(`/mis/line/${d.line}`) });
		out.links!.push({ label: "P&L statement", href: buildHref("/mis/statement") });
	}
	return out;
}

export function cfExplainSection(cf: CashFlowResponse, section: CashFlowSection): ExplainContent {
	return {
		title: section.label,
		context: cf.period.label,
		value: formatINR(section.total),
		formula: "Σ the rows above",
		components: [
			...section.rows.map((r, k) => ({ label: r.label, amount: r.amount, sign: (k === 0 ? "" : signOf(r.amount)) as ExplainRow["sign"] })),
			{ label: "Net", amount: section.total, sign: "=", strong: true },
		],
		check: tieCheck(sum(section.rows.map((r) => r.amount)), section.total, "rows", formatINR(section.total)),
	};
}

export function cfExplainNet(cf: CashFlowResponse): ExplainContent {
	return {
		title: "Net change in cash",
		context: cf.period.label,
		value: formatINR(cf.net_change),
		formula: "Operating + investing + financing",
		components: [
			...cf.sections.map((s, k) => ({ label: s.label, amount: s.total, sign: (k === 0 ? "" : signOf(s.total)) as ExplainRow["sign"] })),
			{ label: "Net change", amount: cf.net_change, sign: "=", strong: true },
		],
		check: tieCheck(sum(cf.sections.map((s) => s.total)), cf.net_change, "sections", formatINR(cf.net_change)),
	};
}

export function cfExplainCash(cf: CashFlowResponse, which: "opening" | "closing", buildHref: BuildHref): ExplainContent {
	const date = which === "opening" ? cf.period.from : cf.period.to;
	const cashRows: ExplainRow[] = cf.cash_accounts.map((a) => ({
		label: a,
		display: "",
		href: buildHref(`/mis/account/${encodeURIComponent(a)}`, { via: "cf" }),
		deskHref: deskAccountHref(a),
	}));
	if (which === "opening") {
		return {
			title: "Opening cash & cash equivalents",
			context: `Balance before ${shortDate(date)}`,
			value: formatINR(cf.opening_cash),
			formula: "Σ asset-side Bank + Cash accounts at the start of the period (OD / CC excluded — a borrowing)",
			sourcesTitle: `Cash accounts (${cash(cf)})`,
			sources: cashRows,
			notes: [cf.policy.od_treatment, "Each account page shows its opening and closing balance for the period."],
		};
	}
	const live = cf.opening_cash + cf.net_change;
	const tie = cf.checks.ties_to_balance_sheet;
	return {
		title: "Closing cash & cash equivalents",
		context: `As of ${shortDate(date)}`,
		value: formatINR(cf.closing_cash),
		formula: "Opening cash + net change in cash = balance-sheet cash on the period end",
		formulaLive: `${formatINR(cf.opening_cash)} ${cf.net_change < 0 ? MINUS : "+"} ${absINR(cf.net_change)} = ${formatINR(live)}`,
		components: [
			{ label: "Opening cash", amount: cf.opening_cash, sign: "" },
			{ label: "Net change in cash", amount: cf.net_change, sign: signOf(cf.net_change) },
			{ label: "Closing cash", amount: live, sign: "=", strong: true },
		],
		sourcesTitle: `Cash accounts (${cash(cf)})`,
		sources: cashRows,
		check: {
			ok: tie,
			text: tie
				? `Closing = balance-sheet cash ✓ (difference ${formatINR(cf.checks.difference)})`
				: `Closing ≠ balance-sheet cash — off by ${formatINR(cf.checks.difference)} ⚠`,
		},
		links: [{ label: `Balance sheet as of ${shortDate(date)}`, href: buildHref("/mis/balance-sheet", { as_of: date }) }],
	};
}

const cash = (cf: CashFlowResponse) => cf.cash_accounts.length;

/* ── Ratios ─────────────────────────────────────────────────────────────── */

/** Favourable / unfavourable direction of a change (not up / down). */
export function ratioTone(r: Ratio): "good" | "bad" | "flat" {
	if (r.change_pct == null || Math.round(r.change_pct) === 0) return "flat";
	return r.change_pct > 0 === r.higher_is_better ? "good" : "bad";
}

export function explainRatio(r: Ratio, opts: { periodLabel: string; annualised: boolean }): ExplainContent {
	const isPct = r.unit === "%";
	const notes: string[] = [];
	if (r.value == null) notes.push("Not meaningful: the denominator is zero or negative for this period.");
	if (opts.annualised && /annualised/i.test(r.formula)) notes.push("The period isn't a full year, so flows are annualised (× 365 ÷ days) before dividing by balances.");
	notes.push(r.higher_is_better ? "Higher is better." : "Lower is better.");
	if (r.prior != null) notes.push(`Prior year ${formatRatio(r, r.prior)}${r.change_pct == null ? "" : ` · change ${formatPct(r.change_pct)}`}.`);
	if (r.flag_25pct) notes.push("⚠ Schedule III: a change of more than 25% vs the prior year must be explained in the notes to accounts.");
	return {
		title: r.label,
		context: opts.periodLabel,
		value: formatRatio(r, r.value),
		formula: r.formula,
		formulaLive:
			r.value == null
				? `${formatINR(r.numerator)} ÷ ${formatINR(r.denominator)}`
				: `${formatINR(r.numerator)} ÷ ${formatINR(r.denominator)}${isPct ? " × 100" : ""} = ${formatRatio(r, r.value)}`,
		components: [
			{ label: "Numerator", amount: r.numerator, sign: "" },
			{ label: "Denominator", amount: r.denominator, sign: "" },
			{ label: r.label, display: formatRatio(r, r.value), sign: "=", strong: true },
		],
		notes,
	};
}

/* ── Controls ───────────────────────────────────────────────────────────── */

export const STATUS_TEXT: Record<ControlCheck["status"], string> = {
	pass: "ties",
	warn: "warning",
	fail: "fails",
	info: "info",
};

export function explainControl(c: ControlCheck, periodLabel: string, focus: "expected" | "actual" | "difference"): ExplainContent {
	const v = focus === "expected" ? c.expected : focus === "actual" ? c.actual : c.difference;
	const ok = c.status === "pass";
	return {
		title: c.label,
		context: `${c.group} · ${periodLabel}`,
		value: formatINR(v),
		valueSub: focus === "difference" ? "actual − expected" : focus,
		formula: "Difference = actual − expected (passes within ₹1, or the check's tolerance)",
		formulaLive: `${formatINR(c.actual)} − ${formatINR(c.expected)} = ${formatINR(c.actual - c.expected)}`,
		components: [
			{ label: "Expected", amount: c.expected, sign: "" },
			{ label: "Actual", amount: c.actual, sign: "" },
			{ label: "Difference", amount: c.difference, sign: "=", strong: true },
		],
		check: {
			ok,
			text: `${c.status === "pass" ? "✓" : c.status === "info" ? "ⓘ" : "⚠"} ${STATUS_TEXT[c.status]}${c.status === "info" ? " — reconciling item, explained below" : ""}`,
		},
		notes: c.detail ? [c.detail] : [],
		links: c.links.map((l) => ({ label: l.label, href: l.url, desk: true })),
	};
}

export function explainBridge(c: ControlCheck, periodLabel: string): ExplainContent {
	const b = c.bridge ?? [];
	const start = b.find((x) => x.kind === "start")?.amount ?? 0;
	const end = b.find((x) => x.kind === "end")?.amount ?? 0;
	const adj = b.filter((x) => x.kind === "adjust");
	return {
		title: `${c.label} · bridge`,
		context: periodLabel,
		value: formatINR(end),
		formula: "Start + adjustments = end",
		components: b.map((x) => ({
			label: x.label,
			amount: x.amount,
			sign: x.kind === "start" ? "" : x.kind === "end" ? "=" : signOf(x.amount),
			strong: x.kind !== "adjust",
		})),
		check: tieCheck(start + sum(adj.map((x) => x.amount)), end, "bridge", formatINR(end)),
	};
}

/* ── Alerts ─────────────────────────────────────────────────────────────── */

export function explainAlert(a: Alert, periodLabel: string, focus: "amount" | "count"): ExplainContent {
	const withAmt = a.rows.filter((r) => r.amount != null);
	const complete = a.count != null && a.rows.length >= a.count;
	const rows: ExplainRow[] = a.rows.slice(0, 12).map((r) => ({
		label: r.label,
		amount: r.amount ?? undefined,
		display: r.amount == null ? (r.count != null ? `${formatNumber(r.count)}` : "") : undefined,
		href: r.url,
		note: [r.qty != null ? `qty ${formatNumber(r.qty, 2)}` : "", r.age != null ? `${r.age} days` : ""].filter(Boolean).join(" · ") || undefined,
	}));
	const shownSum = sum(withAmt.map((r) => r.amount ?? 0));
	const notes = [a.detail];
	if (a.rows.length > rows.length || !complete)
		notes.push(`Showing ${rows.length} of ${a.count ?? a.rows.length} — the largest first. Open the card for the list.`);
	return {
		title: a.label,
		context: `${a.severity} severity · ${periodLabel}`,
		value: focus === "count" ? (a.count == null ? "—" : formatNumber(a.count)) : formatINR(a.amount),
		valueSub: focus === "count" ? (a.amount == null ? undefined : `${formatINR(a.amount)} impact`) : a.count == null ? undefined : `${formatNumber(a.count)} items`,
		formula: focus === "amount" ? "₹ impact = Σ amount of the flagged items" : "Number of flagged items",
		sourcesTitle: "Items (open in ERPNext)",
		sources: rows.length ? rows : undefined,
		check:
			focus === "amount" && a.amount != null && complete && withAmt.length === a.rows.length
				? tieCheck(shownSum, a.amount, "items", formatINR(a.amount))
				: null,
		notes,
		links: a.links.map((l) => ({ label: l.label, href: l.url, desk: true })),
	};
}
