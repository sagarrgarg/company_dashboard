/** /mis/revenue?income_account=…&bucket=… — the invoices behind revenue (ex-tax, returns
 *  netted), 50 a page, each linked to its desk form in a new tab. */
import { useEffect } from "react";
import {
	Breadcrumbs,
	DrillHeader,
	DrillSkeleton,
	DrillTh,
	ExtLink,
	Pager,
	SegTabs,
	StatTile,
	type Crumb,
} from "@/components/drill/DrillLayout";
import { ErrorCard } from "@/components/widgets/ErrorCard";
import { useRevenueDetail } from "@/hooks/useFinance";
import { useComingSoon } from "@/hooks/useUiFlags";
import { BUCKETS, bucketHidden } from "@/lib/pnl";
import { BUCKET_LABEL, deskPartyHref } from "@/lib/explain";
import { useUrlNumber, useUrlParam, useUrlPatch } from "@/lib/urlState";
import { cn, formatINR, formatNumber, shortDate } from "@/lib/utils";
import type { MisPageProps } from "@/App";
import type { PnlBucket } from "@/types/mis";

const PAGE = 50;

export function RevenueDrillPage({ query, onPeriodChange, onLoaded }: MisPageProps) {
	const [bucket] = useUrlParam<PnlBucket>("bucket", "overall", BUCKETS);
	const [incomeAccount] = useUrlParam<string>("income_account", "");
	const [start, setStart] = useUrlNumber("start", 0);
	const flags = useComingSoon();
	const { data, error, isLoading } = useRevenueDetail(query, {
		incomeAccount: incomeAccount || undefined,
		bucket,
		start,
		pageLength: PAGE,
	});
	const d = data?.message;

	useEffect(() => {
		if (d) onLoaded(d.company);
	}, [d, onLoaded]);

	const patch = useUrlPatch();
	const setBucket = (b: PnlBucket) => patch({ bucket: b === "overall" ? null : b, start: null });
	const bucketExtra = { bucket: bucket === "overall" ? null : bucket };
	const crumbs: Crumb[] = [
		{ label: "Overview", path: "/mis" },
		{ label: "Revenue", path: "/mis/line/revenue", extra: bucketExtra },
	];
	if (incomeAccount) {
		crumbs.push({
			label: incomeAccount,
			path: `/mis/account/${encodeURIComponent(incomeAccount)}`,
			extra: { via: "revenue", ...bucketExtra },
		});
	}
	crumbs.push({ label: "Invoices" });

	const header = (
		<>
			<Breadcrumbs items={crumbs} />
			<DrillHeader
				eyebrow={`Revenue · invoices · ${BUCKET_LABEL[bucket]} · ex-tax`}
				title={incomeAccount ? `Invoices booked to ${incomeAccount}` : "Invoices behind revenue"}
				subtitle={d ? `${shortDate(d.from)} – ${shortDate(d.to)} · returns netted (shown negative)` : undefined}
				period={query.period}
				onPeriodChange={onPeriodChange}
				company={query.company}
				right={
					<div className="flex flex-col md:items-end gap-2">
						<SegTabs
							label="Revenue bucket"
							value={bucket}
							onChange={setBucket}
							options={BUCKETS.map((b) => ({ key: b, label: BUCKET_LABEL[b], disabled: bucketHidden(b, flags) }))}
						/>
						{d && <ExtLink href={d.report_url}>Sales Register in ERPNext</ExtLink>}
					</div>
				}
			/>
		</>
	);

	if (bucketHidden(bucket, flags)) {
		return (<>{header}<div className="card text-[13px] text-text-2">Coming soon — an admin can enable this figure in Company Dashboard Settings.</div></>);
	}
	if (isLoading && !d) return (<>{header}<DrillSkeleton /></>);
	if (error || !d) {
		return (
			<>
				{header}
				<ErrorCard title="Unable to load invoices" error={error ?? "The server returned no data."} period={query.period} onPeriodChange={onPeriodChange} />
			</>
		);
	}

	return (
		<>
			{header}
			<div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 mb-4">
				<StatTile label="Revenue (ex-tax)" value={formatINR(d.total)} tone={d.total < 0 ? "red" : "default"} sub="net of returns" />
				<StatTile label="Invoices" value={formatNumber(d.invoice_count)} sub="incl. returns" />
				<StatTile label="Per invoice" value={d.invoice_count ? formatINR(d.total / d.invoice_count) : "—"} sub="average, ex-tax" />
			</div>

			<div className="card !p-0 overflow-hidden">
				<div className="px-5 pt-4 pb-3 border-b border-border">
					<div className="card-title !mb-0">Invoices · largest first</div>
					<div className="text-[11px] text-text-3">Each invoice and customer opens in ERPNext in a new tab</div>
				</div>
				<div className="px-5 md:px-0">
					<table className="drill-table w-full text-[12.5px] tabular-nums">
						<thead>
							<tr>
								<DrillTh align="left">Invoice</DrillTh>
								<DrillTh align="left">Date</DrillTh>
								<DrillTh align="left">Customer</DrillTh>
								<DrillTh>Lines</DrillTh>
								<DrillTh>Revenue</DrillTh>
							</tr>
						</thead>
						<tbody>
							{d.invoices.map((inv) => (
								<tr key={inv.invoice} className="border-b border-border hover:bg-surface-2/50">
									<td className="drill-primary md:px-5 py-2">
										<ExtLink href={inv.url} variant="inline" className="font-semibold">
											{inv.invoice}
										</ExtLink>
										{inv.is_return ? (
											<span className="ml-2 badge !text-[10px] !py-0 bg-red-bg text-red">Return</span>
										) : null}
									</td>
									<td data-label="Date" className="md:px-3 py-2 whitespace-nowrap text-text-2">{shortDate(inv.posting_date)}</td>
									<td data-label="Customer" className="md:px-3 py-2">
										<ExtLink href={deskPartyHref("Customer", inv.customer) ?? "#"} variant="inline">
											{inv.customer_name || inv.customer}
										</ExtLink>
									</td>
									<td data-label="Lines" className="md:px-3 py-2 text-right text-text-3">{formatNumber(inv.line_count)}</td>
									<td data-label="Revenue" className={cn("md:px-3 py-2 text-right font-semibold whitespace-nowrap", inv.revenue < 0 && "text-red")}>
										{formatINR(inv.revenue)}
									</td>
								</tr>
							))}
							{d.invoices.length === 0 && (
								<tr>
									<td colSpan={5} className="px-5 py-8 text-center text-text-3">No invoices in this period.</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
				<div className="px-5 pb-4">
					<Pager start={d.start} pageLength={d.page_length || PAGE} total={d.invoice_count} onChange={setStart} noun="invoices" />
				</div>
			</div>
		</>
	);
}
