/** /mis/account/:account?via=<line|wc>&bucket=… — one GL account over the period:
 *  opening / debit / credit / movement / closing, monthly net, and the vouchers (50 a page,
 *  largest or newest first), each linked to its desk form in a new tab. */
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import {
	Breadcrumbs,
	DrillHeader,
	DrillSkeleton,
	DrillTh,
	ExtLink,
	MonthlyBars,
	Pager,
	SegTabs,
	StatTile,
	type Crumb,
} from "@/components/drill/DrillLayout";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { useLedgerDetail } from "@/hooks/useFinance";
import { BUCKETS, isStepKey, ladderLabel, parentTier } from "@/lib/pnl";
import { deskPartyHref } from "@/lib/explain";
import { useUrlNumber, useUrlParam, useUrlPatch } from "@/lib/urlState";
import { cn, formatINR, formatNumber, monthLabel, partialMonthKeys, shortDate } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { LedgerOrder } from "@/types/finance";
import type { PnlBucket } from "@/types/mis";

const PAGE = 50;
const ORDERS: readonly LedgerOrder[] = ["amount", "date"] as const;

export function AccountDrillPage({ query, onPeriodChange, onLoaded }: MisPageProps) {
	const { account = "" } = useParams();
	const [from] = useUrlParam<string>("via", ""); // the line (or "wc") it was opened from — crumbs only
	const [bucket] = useUrlParam<PnlBucket>("bucket", "overall", BUCKETS);
	const [order] = useUrlParam<LedgerOrder>("sort", "amount", ORDERS);
	const patch = useUrlPatch();
	const [start, setStart] = useUrlNumber("start", 0);
	const { data, error, isLoading } = useLedgerDetail(query, { account, start, pageLength: PAGE, orderBy: order });
	const d = data?.message;

	useEffect(() => {
		if (d) onLoaded(d.company);
	}, [d, onLoaded]);

	const bucketExtra = { bucket: bucket === "overall" ? null : bucket };
	const crumbs: Crumb[] = [];
	if (from === "wc") {
		crumbs.push({ label: "Working Capital", path: "/wc" });
	} else if (from === "bs") {
		crumbs.push({ label: "Balance sheet", path: "/mis/balance-sheet", extra: { as_of: query.period.kind === "ttm" ? null : query.period.to } });
	} else if (from === "cf") {
		crumbs.push({ label: "Cash flow", path: "/mis/cash-flow" });
	} else {
		crumbs.push({ label: "Overview", path: "/mis" });
		if (isStepKey(from)) {
			const tier = parentTier(from);
			if (tier) crumbs.push({ label: short(ladderLabel(tier)), path: `/mis/line/${tier}`, extra: bucketExtra });
			crumbs.push({ label: ladderLabel(from), path: `/mis/line/${from}`, extra: bucketExtra });
		}
	}
	crumbs.push({ label: account });

	const header = (
		<>
			<Breadcrumbs items={crumbs} />
			<DrillHeader
				eyebrow={`GL account${d ? ` · ${d.account.root_type}${d.account.account_type ? ` · ${d.account.account_type}` : ""}` : ""}`}
				title={account}
				subtitle={
					d ? (
						<>
							{shortDate(d.from)} – {shortDate(d.to)}
							{d.account.is_group ? ` · group account · ${formatNumber(d.account.leaf_count)} leaf accounts rolled up` : ""}
							{d.account.parent_account ? ` · under ${d.account.parent_account}` : ""}
						</>
					) : undefined
				}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
				right={
					d && (
						<div className="flex flex-wrap gap-2 md:justify-end">
							<ExtLink href={d.gl_report_url} variant="primary">
								Open in ERPNext General Ledger
							</ExtLink>
							<ExtLink href={d.account.url}>Account in ERPNext</ExtLink>
						</div>
					)
				}
			/>
		</>
	);

	if (!account) return (<>{header}<ErrorCard title="No account" error="The link has no account name." /></>);
	if (isLoading && !d) return (<>{header}<DrillSkeleton /></>);
	if (error || !d) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load the account" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}

	const partial = partialMonthKeys({ from: d.from, to: d.to });
	const isPl = d.account.is_pl;
	const monthly = d.monthly.map((m) => ({ key: m.key, label: monthLabel(m.key), value: m.net, partial: partial.has(m.key) }));
	const balanceTie = Math.abs(d.opening + d.movement - d.closing) <= 1;

	return (
		<>
			{header}
			<div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 mb-4">
				<StatTile label="Opening" value={formatINR(d.opening)} sub={isPl ? "P&L accounts open at 0" : `as of ${shortDate(d.from)}`} />
				<StatTile label="Debit" value={formatINR(d.debit)} />
				<StatTile label="Credit" value={formatINR(d.credit)} />
				<StatTile label="Movement" value={formatINR(d.movement)} tone={d.movement < 0 ? "red" : "default"} sub="debit − credit" />
				<StatTile
					label="Closing"
					value={formatINR(d.closing)}
					sub={<span className={balanceTie ? "text-green" : "text-amber"}>{balanceTie ? "opening + movement ✓" : "⚠ opening + movement ≠ closing"}</span>}
				/>
			</div>

			<div className="card mb-4">
				<div className="card-title mb-0.5">Monthly net movement</div>
				<div className="text-[11px] text-text-3 font-medium mb-3">debit − credit per month · dashed = month to date</div>
				<MonthlyBars data={monthly} valueLabel="Net" />
			</div>

			<div className="card !p-0 overflow-hidden">
				<div className="px-5 pt-4 pb-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
					<div>
						<div className="card-title !mb-0">Vouchers</div>
						<div className="text-[11px] text-text-3">{formatNumber(d.voucher_count)} GL entries in the period · each opens in ERPNext in a new tab</div>
					</div>
					<SegTabs
						label="Sort vouchers"
						value={order}
						onChange={(o) => patch({ sort: o === "amount" ? null : o, start: null })}
						options={[
							{ key: "amount", label: "Largest first" },
							{ key: "date", label: "Newest first" },
						]}
					/>
				</div>
				<div className="px-5 md:px-0">
					<table className="drill-table w-full text-[12.5px] tabular-nums">
						<thead>
							<tr>
								<DrillTh align="left">Date</DrillTh>
								<DrillTh align="left">Voucher</DrillTh>
								<DrillTh align="left">Party</DrillTh>
								<DrillTh>Debit</DrillTh>
								<DrillTh>Credit</DrillTh>
								<DrillTh>Net</DrillTh>
							</tr>
						</thead>
						<tbody>
							{d.vouchers.map((v, i) => {
								const partyHref = deskPartyHref(v.party_type, v.party);
								return (
									<tr key={`${v.voucher_no}-${i}`} className="border-b border-border hover:bg-surface-2/50 align-top">
										<td data-label="Date" className="md:px-5 py-2 whitespace-nowrap text-text-2">{shortDate(v.posting_date)}</td>
										<td className="drill-primary md:px-3 py-2 min-w-0">
											<div className="flex flex-col items-start">
												<ExtLink href={v.url} variant="inline" className="font-semibold">
													{v.voucher_no}
												</ExtLink>
												<span className="text-[10.5px] text-text-3 font-normal">{v.voucher_type}</span>
												{(v.remarks && v.remarks !== "No Remarks") || v.against ? (
													<span className="text-[10.5px] text-text-4 font-normal break-words max-w-[420px]" title={v.remarks ?? undefined}>
														{v.against ? `against ${truncate(v.against, 60)}` : ""}
														{v.remarks && v.remarks !== "No Remarks" ? `${v.against ? " · " : ""}${truncate(v.remarks, 90)}` : ""}
													</span>
												) : null}
											</div>
										</td>
										<td data-label="Party" className="md:px-3 py-2 text-left">
											{v.party ? (
												partyHref ? (
													<ExtLink href={partyHref} variant="inline">{v.party}</ExtLink>
												) : (
													v.party
												)
											) : (
												<span className="text-text-4">—</span>
											)}
										</td>
										<td data-label="Debit" className="md:px-3 py-2 text-right whitespace-nowrap">{v.debit ? formatINR(v.debit) : ""}</td>
										<td data-label="Credit" className="md:px-3 py-2 text-right whitespace-nowrap">{v.credit ? formatINR(v.credit) : ""}</td>
										<td data-label="Net" className={cn("md:px-3 py-2 text-right whitespace-nowrap font-semibold", v.net < 0 && "text-red")}>
											{formatINR(v.net)}
										</td>
									</tr>
								);
							})}
							{d.vouchers.length === 0 && (
								<tr>
									<td colSpan={6} className="px-5 py-8 text-center text-text-3">No GL entries on this account in the period.</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
				<div className="px-5 pb-4">
					<Pager start={d.start} pageLength={d.page_length || PAGE} total={d.voucher_count} onChange={setStart} noun="entries" />
				</div>
			</div>
		</>
	);
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function short(label: string): string {
	return label.split("·")[0]?.trim() || label;
}
