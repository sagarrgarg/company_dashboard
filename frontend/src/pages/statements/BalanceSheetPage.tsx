/** /mis/balance-sheet?as_of=YYYY-MM-DD — Schedule III balance sheet: Assets | Equity &
 *  Liabilities, as of / same date last year / last FY close + change. Every line explains
 *  its accounts (with the classification rule) and expands to list them; each account
 *  opens its ledger (FY start → as of) in a new tab. */
import { Fragment, useEffect, useState } from "react";
import { DrillHeader, DrillSkeleton, ExtLink } from "@/components/drill/DrillLayout";
import { Explain } from "@/components/explain/Explain";
import { PreparedReportHeader } from "@/components/widgets/PreparedReportHeader";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { TieBadge } from "@/components/statements/StatementBits";
import { useBalanceSheet } from "@/hooks/useFinance";
import {
	bsAccountHref,
	bsExplainChange,
	bsExplainLine,
	bsExplainSection,
	bsExplainSide,
	type BuildHref,
} from "@/lib/statements";
import { TIE_TOLERANCE, type ExplainContent } from "@/lib/explain";
import { useDashState, useUrlParam } from "@/lib/urlState";
import { cn, formatINR, formatUnit, isNil, shortDate, todayIso, UNIT_LABEL } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { BalanceSheetResponse, BsColumn, BsRow } from "@/types/finance";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function BalanceSheetPage({ query, onLoaded, onRefreshed }: MisPageProps) {
	const today = todayIso();
	// Default: the period end (capped at today); the URL's as_of wins.
	const periodEnd = query.period.kind === "ttm" ? today : query.period.to < today ? query.period.to : today;
	const [asOfParam, setAsOf] = useUrlParam<string>("as_of", "");
	const asOf = ISO.test(asOfParam) ? asOfParam : periodEnd;
	const { data, error, isLoading } = useBalanceSheet(asOf, query.company, query.refreshKey);
	const bs = data?.message;
	const { buildHref } = useDashState();

	useEffect(() => {
		if (bs) onLoaded(bs.company);
	}, [bs, onLoaded]);

	const fyClose = bs?.columns.find((c) => c.key === "last_fy_close")?.date;
	const quick: Array<{ label: string; date: string }> = [{ label: "Today", date: today }];
	if (periodEnd !== today) quick.push({ label: "Period end", date: periodEnd });
	if (fyClose) quick.push({ label: "Last FY close", date: fyClose });

	const header = (
		<>
			<PreparedReportHeader refreshedAt={bs?.refreshed_at} stale={bs?.stale} section="mis" onRefreshed={onRefreshed} />
			<DrillHeader
				eyebrow={`Statements · Balance sheet · Schedule III · ${UNIT_LABEL.lakh}`}
				title="Balance sheet"
				subtitle={bs ? `As of ${shortDate(bs.as_of)} · ${bs.company}` : `As of ${shortDate(asOf)}`}
				company={query.company}
				right={
					<div className="flex flex-col md:items-end gap-2">
						<div className="flex flex-wrap items-center gap-2 md:justify-end">
							<label className="inline-flex items-center gap-2 text-[11px] font-semibold text-text-3">
								As of
								<input
									type="date"
									value={asOf}
									max={today}
									onChange={(e) => ISO.test(e.target.value) && setAsOf(e.target.value === periodEnd ? "" : e.target.value)}
									className="min-h-[34px] px-3 rounded-full border border-border-md bg-surface text-[12px] font-semibold text-text tabular-nums"
								/>
							</label>
							{quick.map((q) => (
								<button
									key={q.label}
									type="button"
									onClick={() => setAsOf(q.date === periodEnd ? "" : q.date)}
									className={cn(
										"min-h-[30px] px-3 rounded-full text-[11px] font-semibold border",
										q.date === asOf ? "bg-green text-white border-green" : "border-border-md text-text-2 bg-surface hover:bg-surface-2",
									)}
								>
									{q.label}
								</button>
							))}
						</div>
						{bs && <BalancedBadge bs={bs} buildHref={buildHref} />}
					</div>
				}
			/>
		</>
	);

	if (isLoading && !bs) return (<>{header}<DrillSkeleton /></>);
	if (error || !bs) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load the balance sheet" error={error ?? "The server returned no data."} />
			</>
		);
	}
	return (
		<>
			{header}
			<BalanceSheetBody bs={bs} buildHref={buildHref} />
		</>
	);
}

function BalancedBadge({ bs, buildHref }: { bs: BalanceSheetResponse; buildHref: BuildHref }) {
	const col = bs.columns[0];
	const ok = bs.checks.balanced && Math.abs(bs.checks.difference) <= TIE_TOLERANCE;
	return (
		<TieBadge ok={ok} tone={ok ? "green" : "red"} content={() => balancedExplain(bs, col, buildHref)}>
			{ok ? "✓ Assets = Equity + Liabilities" : `⚠ Off by ${formatINR(bs.checks.difference)}`}
		</TieBadge>
	);
}

function balancedExplain(bs: BalanceSheetResponse, col: BsColumn, buildHref: BuildHref): ExplainContent {
	const t = bs.totals[col.key];
	const ok = bs.checks.balanced;
	return {
		title: "Balance check",
		context: col.label,
		value: ok ? "✓ balanced" : `⚠ ${formatINR(t.difference)}`,
		formula: "Total assets − (equity + liabilities, incl. profit not yet closed to reserves)",
		formulaLive: `${formatINR(t.assets)} − ${formatINR(t.equity_liabilities)} = ${formatINR(t.difference)}`,
		components: [
			{ label: "Total assets", amount: t.assets, sign: "" },
			{ label: "Equity + liabilities", amount: t.equity_liabilities, sign: "−" },
			{ label: "Difference", amount: t.difference, sign: "=", strong: true },
		],
		check: { ok, text: ok ? "Assets = equity + liabilities ✓" : "Not balanced ⚠" },
		notes: [
			`Trial balance difference (Σ debit − Σ credit up to ${shortDate(bs.as_of)}): ${formatINR(bs.checks.trial_balance_difference)}.`,
			"The Controls page also checks this against ERPNext's own Balance Sheet.",
		],
		links: [{ label: "Controls", href: buildHref("/mis/controls") }],
	};
}

function BalanceSheetBody({ bs, buildHref }: { bs: BalanceSheetResponse; buildHref: BuildHref }) {
	const fb = bs.checks.fallback_accounts;
	const p = bs.provisional;
	return (
		<>
			{fb.length > 0 && (
				<div className="card mb-4 border-amber/40 bg-amber-bg/40" role="status">
					<div className="card-title !mb-1 text-amber">⚠ {fb.length} account{fb.length === 1 ? "" : "s"} placed by fallback</div>
					<p className="text-[12px] text-text-2 mb-2">
						No rule matched {fb.length === 1 ? "this account" : "these accounts"}, so {fb.length === 1 ? "it was" : "they were"} put on a default line by root
						type. Add an override in Company Dashboard Settings → Balance sheet line overrides.
					</p>
					<ul className="text-[12px] space-y-1 mb-3">
						{fb.map((a) => (
							<li key={a.account} className="flex flex-wrap gap-x-2 tabular-nums">
								<a
									href={bsAccountHref(buildHref, a.account, p.fy_start, bs.as_of)}
									target="_blank"
									rel="noopener"
									className="text-green font-semibold hover:underline underline-offset-2"
								>
									{a.account} <span aria-hidden="true">↗</span>
								</a>
								<span className="text-text-3">→ {a.line} · {a.rule}</span>
								<span className="font-semibold">{formatINR(a.balance)}</span>
							</li>
						))}
					</ul>
					<ExtLink href="/app/company-dashboard-settings">Company Dashboard Settings</ExtLink>
				</div>
			)}

			<div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
				<SideTable bs={bs} side="assets" title="Assets" buildHref={buildHref} />
				<SideTable bs={bs} side="equity_liabilities" title="Equity & liabilities" buildHref={buildHref} />
			</div>

			<div className="mt-3 text-[10.5px] text-text-3 leading-[1.7]">
				Amounts in {UNIT_LABEL.lakh}. Assets are debit balances; equity &amp; liabilities are credit balances — a figure marked{" "}
				<span className="text-amber font-semibold">Dr</span> on that side is a net debit balance (shown, not hidden). Change = as of − last FY close.
				Profit not yet closed: current FY {formatINR(p.current_fy)} (from {shortDate(p.fy_start)})
				{Math.abs(p.prior_unclosed) >= 0.5 && <> + earlier years without a Period Closing Voucher {formatINR(p.prior_unclosed)}</>}. Click a line to list its
				accounts; each opens its ledger from {shortDate(p.fy_start)} to {shortDate(bs.as_of)} in a new tab.
			</div>
		</>
	);
}

function SideTable({
	bs,
	side,
	title,
	buildHref,
}: {
	bs: BalanceSheetResponse;
	side: "assets" | "equity_liabilities";
	title: string;
	buildHref: BuildHref;
}) {
	const sections = bs.sections.filter((s) => s.side === side);
	const cols = bs.columns;
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const liab = side === "equity_liabilities";
	const colCount = cols.length + 2;

	return (
		<div className="card !p-0 overflow-hidden">
			<div className="px-4 md:px-5 pt-4 pb-3 border-b border-border flex items-baseline justify-between gap-3">
				<div className="card-title !mb-0">{title}</div>
				<div className="text-[10px] text-text-3 uppercase tracking-[0.08em] font-semibold">{liab ? "credit balances" : "debit balances"}</div>
			</div>
			<div className="overflow-x-auto overscroll-x-contain">
				<table className="stmt-table w-full text-[12px]">
					<thead>
						<tr>
							<th className="stmt-sticky text-left px-3 md:px-4 py-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-text-3 min-w-[140px] md:min-w-[190px]">
								{UNIT_LABEL.lakh}
							</th>
							{cols.map((c) => (
								<th key={c.key} scope="col" className={cn("px-2.5 py-2 text-right text-[10px] font-semibold tracking-[0.04em] uppercase text-text-3", c.key === "as_of" && "text-text")}>
									{c.key === "as_of" ? shortDate(c.date) : c.key === "prior_year" ? `PY ${shortDate(c.date)}` : `FY close`}
								</th>
							))}
							<th scope="col" className="px-2.5 py-2 text-right text-[10px] font-semibold tracking-[0.04em] uppercase text-text-3">Change</th>
						</tr>
					</thead>
					<tbody>
						{sections.map((sec) => (
							<Fragment key={sec.key}>
								<tr className="stmt-group">
									<th scope="rowgroup" className="stmt-sticky text-left px-3 md:px-4 pt-3 pb-1.5 text-[9.5px] font-semibold tracking-[0.12em] uppercase text-text-3">
										{sec.label}
									</th>
									<td colSpan={colCount - 1} />
								</tr>
								{sec.rows.length === 0 && (
									<tr>
										<td className="stmt-sticky pl-6 py-2 text-text-4 text-[11.5px]">No balances</td>
										<td colSpan={colCount - 1} />
									</tr>
								)}
								{sec.rows.map((row) => {
									const id = `${sec.key}:${row.key}`;
									const isOpen = !!open[id];
									const hasAccounts = row.accounts.length > 0;
									return (
										<Fragment key={row.key}>
											<tr>
												<th scope="row" className="stmt-sticky text-left pl-3 md:pl-4 pr-2 py-1.5 font-normal text-text">
													{hasAccounts ? (
														<button
															type="button"
															onClick={() => setOpen((o) => ({ ...o, [id]: !o[id] }))}
															aria-expanded={isOpen}
															className="flex items-center gap-1.5 text-left min-h-[24px] hover:text-green"
														>
															<span className={cn("text-[9px] text-text-4 transition-transform", isOpen && "rotate-90")} aria-hidden="true">▶</span>
															<span className="leading-snug">
																{row.label}
																<span className="ml-1 text-[10px] text-text-4">{row.accounts.length}</span>
															</span>
														</button>
													) : (
														<span className="pl-4 leading-snug inline-block">{row.label}</span>
													)}
												</th>
												{cols.map((c) => (
													<td key={c.key} className={cn("px-2.5 py-1.5 text-right", c.key === "as_of" && "font-semibold")}>
														<BsValue
															v={row.values[c.key]}
															liab={liab}
															content={() => bsExplainLine(bs, sec, row, c, buildHref)}
															label={`${row.label}, ${c.label}`}
														/>
													</td>
												))}
												<td className="px-2.5 py-1.5 text-right text-text-2">
													<Explain content={() => bsExplainChange(bs, sec, row)} underline={false} label={`${row.label}, change ${formatINR(row.change)}`}>
														{isNil(row.change) ? <span className="text-text-4">–</span> : formatUnit(row.change)}
													</Explain>
												</td>
											</tr>
											{isOpen && <AccountRows bs={bs} row={row} colCount={colCount} buildHref={buildHref} />}
										</Fragment>
									);
								})}
								<tr className="stmt-tier">
									<th scope="row" className="stmt-sticky text-left px-3 md:px-4 py-2 font-semibold text-text">Total {sec.label.toLowerCase()}</th>
									{cols.map((c) => (
										<td key={c.key} className="px-2.5 py-2 text-right">
											<BsValue v={sec.totals[c.key]} liab={liab} content={() => bsExplainSection(sec, c)} label={`Total ${sec.label}, ${c.label}`} />
										</td>
									))}
									<td className="px-2.5 py-2 text-right text-text-2">{formatUnit(sec.totals.as_of - sec.totals.last_fy_close)}</td>
								</tr>
							</Fragment>
						))}
						<tr className="stmt-tier stmt-final">
							<th scope="row" className="stmt-sticky text-left px-3 md:px-4 py-2.5 font-bold text-text uppercase text-[11px] tracking-[0.06em]">
								Total {title.toLowerCase()}
							</th>
							{cols.map((c) => {
								const t = bs.totals[c.key];
								const v = side === "assets" ? t.assets : t.equity_liabilities;
								return (
									<td key={c.key} className="px-2.5 py-2.5 text-right font-bold">
										<BsValue v={v} liab={liab} content={() => bsExplainSide(bs, side, c)} label={`Total ${title}, ${c.label}`} />
									</td>
								);
							})}
							<td className="px-2.5 py-2.5 text-right text-text-2 font-semibold">
								{formatUnit(
									side === "assets"
										? bs.totals.as_of.assets - bs.totals.last_fy_close.assets
										: bs.totals.as_of.equity_liabilities - bs.totals.last_fy_close.equity_liabilities,
								)}
							</td>
						</tr>
					</tbody>
				</table>
			</div>
		</div>
	);
}

/** One balance (₹ lakh) — negative on its natural side gets a Dr / Cr marker. */
function BsValue({
	v,
	liab,
	content,
	label,
}: {
	v: number;
	liab: boolean;
	content: () => ExplainContent;
	label: string;
}) {
	const nil = isNil(v);
	const contra = !nil && v < 0;
	return (
		<Explain content={content} underline={false} label={`${label}, ${formatINR(v)}${contra ? (liab ? ", net debit balance" : ", net credit balance") : ""}`}>
			<span className={cn(nil && "text-text-4", contra && "text-amber")}>
				{nil ? "–" : formatUnit(v)}
				{contra && <sup className="ml-0.5 text-[8.5px] font-semibold">{liab ? "Dr" : "Cr"}</sup>}
			</span>
		</Explain>
	);
}

function AccountRows({ bs, row, colCount, buildHref }: { bs: BalanceSheetResponse; row: BsRow; colCount: number; buildHref: BuildHref }) {
	const accts = [...row.accounts].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
	return (
		<>
			{accts.map((a, i) => (
				<tr key={(a.account ?? a.label) + i} className="text-[11.5px]">
					<td className="stmt-sticky pl-8 md:pl-10 pr-2 py-1 text-text-2">
						{a.account ? (
							<>
								<a
									href={bsAccountHref(buildHref, a.account, bs.provisional.fy_start, bs.as_of)}
									target="_blank"
									rel="noopener"
									className="hover:text-green hover:underline underline-offset-2 break-words"
								>
									{a.account} <span className="text-text-4" aria-hidden="true">↗</span>
								</a>
								<div className="text-[10px] text-text-4">{a.rule}</div>
							</>
						) : (
							<span className="italic">{a.label}</span>
						)}
					</td>
					<td className={cn("px-2.5 py-1 text-right", a.amount < 0 && "text-amber")}>{formatUnit(a.amount)}</td>
					<td colSpan={colCount - 2} />
				</tr>
			))}
		</>
	);
}

