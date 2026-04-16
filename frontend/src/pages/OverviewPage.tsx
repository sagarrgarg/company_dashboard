import { useEffect } from "react";
import { KpiTile } from "@/components/widgets/KpiTile";
import { MarginTile } from "@/components/widgets/MarginTile";
import { RevenueTrendChart } from "@/components/widgets/RevenueTrendChart";
import { RevenueMixChart } from "@/components/widgets/RevenueMixChart";
import { CategoryTable } from "@/components/widgets/CategoryTable";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { DownloadExcelButton } from "@/components/widgets/DownloadExcelButton";
import { useOverview } from "@/hooks/useOverview";
import { cn, formatDelta, formatINRShort, formatPct } from "@/lib/utils";
import type { OverviewResponse, PeriodSelection, TaxMode } from "@/types/mis";

function pctDelta(cur: number, prior: number): number | null {
	if (!prior) return null;
	return ((cur - prior) / prior) * 100;
}

interface Props {
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
	onCompanyResolved?: (company: string) => void;
}

export function OverviewPage({
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
	onCompanyResolved,
}: Props) {
	const { data, error, isLoading } = useOverview(taxMode, period);
	const res = data?.message;
	const resolvedCompany = res?.company;

	useEffect(() => {
		if (resolvedCompany && onCompanyResolved) {
			onCompanyResolved(resolvedCompany);
		}
	}, [resolvedCompany, onCompanyResolved]);

	if (isLoading) {
		return (
			<LoadingShell
				taxMode={taxMode}
				onTaxModeChange={onTaxModeChange}
				period={period}
				onPeriodChange={onPeriodChange}
			/>
		);
	}
	if (error || !res) return <ErrorShell message={error?.message ?? "No data"} />;

	return (
		<OverviewBody
			res={res}
			taxMode={taxMode}
			onTaxModeChange={onTaxModeChange}
			period={period}
			onPeriodChange={onPeriodChange}
		/>
	);
}

function OverviewBody({
	res,
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
}: {
	res: OverviewResponse;
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
}) {
	const { kpi, monthly, categories, period: periodInfo } = res;
	const totalDelta = formatDelta(pctDelta(kpi.total_revenue, kpi.total_revenue_prior));
	const b2cDelta = formatDelta(pctDelta(kpi.b2c_revenue, kpi.b2c_revenue_prior));
	const b2bDelta = formatDelta(pctDelta(kpi.b2b_revenue, kpi.b2b_revenue_prior));
	const mix = kpi.total_revenue
		? {
				b2c: Math.round((kpi.b2c_revenue / kpi.total_revenue) * 100),
				b2b: Math.round((kpi.b2b_revenue / kpi.total_revenue) * 100),
			}
		: { b2c: 0, b2b: 0 };
	const taxLabel = taxMode === "incl" ? "Tax-inclusive" : "Tax-exclusive";

	return (
		<>
			<header className="flex justify-between items-start mb-7 gap-4">
				<div>
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						MIS Overview · {taxLabel}
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
						{res.company}
					</h1>
					<div className="text-[12px] text-text-2 mt-1.5 font-medium">
						{periodInfo.label} · {categories.length} categories · {kpi.active_skus} live SKUs
					</div>
					<div className="flex gap-1.5 mt-3 flex-wrap">
						<span className="badge bg-green-bg text-green">
							B2C {b2cDelta.label} YoY
						</span>
						<span className="badge bg-amber-bg text-amber">
							B2B {b2bDelta.label} YoY
						</span>
						<span className="badge bg-blue-bg text-blue">
							GM {formatPct(kpi.gross_margin_pct)}
						</span>
						<span className="badge bg-teal-bg text-teal">
							CM1 {formatPct(kpi.cm1_pct)}
						</span>
						<span className="badge bg-purple-bg text-purple">
							CM2 {formatPct(kpi.cm2_pct)}
						</span>
						<span
							className={cn(
								"badge",
								kpi.cm3_pct >= 0
									? "bg-green-bg text-green"
									: "bg-red-bg text-red",
							)}
						>
							CM3 {formatPct(kpi.cm3_pct)}
						</span>
						<span
							className={cn(
								"badge font-semibold",
								kpi.pat_pct >= 0
									? "bg-green-bg text-green"
									: "bg-red-bg text-red",
							)}
						>
							PAT {formatPct(kpi.pat_pct)}
						</span>
					</div>
				</div>
				<div className="flex flex-col items-end gap-2.5">
					<div className="flex items-center gap-2 flex-wrap justify-end">
						<DownloadExcelButton taxMode={taxMode} period={period} />
						<PeriodPicker value={period} onChange={onPeriodChange} />
						<TaxModeTabs value={taxMode} onChange={onTaxModeChange} />
					</div>
					<div className="text-right">
						<div className="text-[10px] font-semibold tracking-[0.12em] uppercase text-text-3">
							Total Revenue
						</div>
						<div className="text-[34px] font-semibold text-text leading-[1.05] tracking-tight tabular-nums">
							{formatINRShort(kpi.total_revenue)}
						</div>
						<div
							className={cn(
								"text-[12px] font-medium tabular-nums",
								totalDelta.direction === "up"
									? "text-green"
									: totalDelta.direction === "down"
										? "text-red"
										: "text-text-3",
							)}
						>
							{totalDelta.label} vs prior TTM
						</div>
					</div>
				</div>
			</header>

			<div className="sec-label">Revenue KPIs — TTM · {taxLabel}</div>
			<div className="grid grid-cols-5 gap-2.5 mb-2.5">
				<KpiTile
					label="Total Revenue"
					value={formatINRShort(kpi.total_revenue)}
					delta={totalDelta}
					meta="prior TTM"
				/>
				<KpiTile
					label="B2C Revenue"
					value={formatINRShort(kpi.b2c_revenue)}
					accent="green"
					delta={b2cDelta}
					meta={`${mix.b2c}% mix`}
				/>
				<KpiTile
					label="B2B Revenue"
					value={formatINRShort(kpi.b2b_revenue)}
					accent="amber"
					delta={b2bDelta}
					meta={`${mix.b2b}% mix`}
				/>
				<KpiTile
					label="CM1 · Gross Margin"
					value={formatPct(kpi.cm1_pct)}
					accent={kpi.cm1_pct > 2 ? "green" : kpi.cm1_pct > 0 ? "amber" : "red"}
					meta={`(Rev − COGS) · ${Math.round(kpi.gross_margin_coverage_pct)}% valuated`}
				/>
				<KpiTile
					label="CM2 · Before marketing"
					value={formatPct(kpi.cm2_pct)}
					accent={kpi.cm2_pct > 2 ? "green" : kpi.cm2_pct > 0 ? "amber" : "red"}
					meta={`CM1 − ${formatINRShort(kpi.cm2_deduction)} variable`}
				/>
			</div>

			<div className="sec-label mt-5">Profit ladder — TTM · tax-excl</div>
			<div className="grid grid-cols-5 gap-2.5">
				<KpiTile
					label="CM3 · After marketing"
					value={formatPct(kpi.cm3_pct)}
					accent={kpi.cm3_pct > 2 ? "green" : kpi.cm3_pct > 0 ? "amber" : "red"}
					meta={`CM2 − ${formatINRShort(kpi.cm3_deduction)} marketing`}
				/>
				<KpiTile
					label="EBITDA"
					value={formatPct(kpi.ebitda_pct)}
					accent={kpi.ebitda_pct > 5 ? "green" : kpi.ebitda_pct > 0 ? "amber" : "red"}
					meta={`CM3 − ${formatINRShort(res.ladder_inputs.operating_total)} opex`}
				/>
				<KpiTile
					label="EBIT"
					value={formatPct(kpi.ebit_pct)}
					accent={kpi.ebit_pct > 5 ? "green" : kpi.ebit_pct > 0 ? "amber" : "red"}
					meta={
						res.ladder_inputs.da_total > 0
							? `EBITDA − ${formatINRShort(res.ladder_inputs.da_total)} D&A`
							: "no D&A booked TTM"
					}
				/>
				<KpiTile
					label="PAT"
					value={formatPct(kpi.pat_pct)}
					accent={kpi.pat_pct > 0 ? "green" : "red"}
					meta={`− ${formatINRShort(res.ladder_inputs.interest_total)} int · ${formatINRShort(res.ladder_inputs.tax_total)} tax`}
				/>
				<KpiTile
					label="Gross Profit"
					value={formatINRShort(kpi.gross_profit)}
					accent={kpi.gross_profit > 0 ? "green" : "red"}
					meta="abs ₹ · TTM"
				/>
			</div>

			<div className="mt-2.5 grid grid-cols-5 gap-2.5">
				<KpiTile
					label="Active SKUs"
					value={String(kpi.active_skus)}
					accent="blue"
					meta="items with sales"
				/>
				<KpiTile
					label="Unclassified Rev"
					value={formatINRShort(kpi.unclassified_revenue)}
					accent={
						kpi.unclassified_revenue > kpi.total_revenue * 0.2 ? "amber" : "default"
					}
					meta={`${Math.round((kpi.unclassified_revenue / (kpi.total_revenue || 1)) * 100)}% of total`}
				/>
				<KpiTile
					label="Operating Opex"
					value={formatINRShort(res.ladder_inputs.operating_total)}
					meta={`sal ${formatINRShort(res.ladder_inputs.salary_total)} · rent ${formatINRShort(res.ladder_inputs.rent_total)}`}
				/>
				<KpiTile
					label="Interest & Finance"
					value={formatINRShort(res.ladder_inputs.interest_total)}
					accent={res.ladder_inputs.interest_total > 0 ? "amber" : "default"}
					meta={`${res.ladder_inputs.interest_accounts.length} account${res.ladder_inputs.interest_accounts.length === 1 ? "" : "s"}`}
				/>
				<KpiTile
					label="Income Tax"
					value={formatINRShort(res.ladder_inputs.tax_total)}
					meta={
						res.ladder_inputs.tax_total > 0
							? `${res.ladder_inputs.tax_accounts.length} account${res.ladder_inputs.tax_accounts.length === 1 ? "" : "s"}`
							: "none TTM (likely losses)"
					}
				/>
			</div>

			<div className="mt-4">
				<MarginTile
					overall={{
						label: "Overall",
						gpPct: kpi.gross_margin_pct,
						gp: kpi.gross_profit,
						coverage: kpi.gross_margin_coverage_pct,
					}}
					b2c={{
						label: "B2C",
						gpPct: kpi.b2c_gross_margin_pct,
						gp: kpi.b2c_gross_profit,
						coverage: kpi.b2c_gross_margin_coverage_pct,
					}}
					b2b={{
						label: "B2B",
						gpPct: kpi.b2b_gross_margin_pct,
						gp: kpi.b2b_gross_profit,
						coverage: kpi.b2b_gross_margin_coverage_pct,
					}}
				/>
			</div>

			<div className="mt-3 text-[10.5px] text-text-3 leading-[1.7]">
				<div>
					<span className="font-semibold text-text-2">CM1 (GM):</span> Revenue − COGS ·
					computed from Sales Invoice Item × incoming_rate (no account config)
				</div>
				<div>
					<span className="font-semibold text-text-2">CM2:</span> freight{" "}
					{formatINRShort(res.cm2_inputs.freight_total)} ·{" "}
					{res.cm2_inputs.freight_accounts.length} acc · packaging{" "}
					{formatINRShort(res.cm2_inputs.packaging_total)} ·{" "}
					{res.cm2_inputs.packaging_accounts.length} acc · txn fees{" "}
					{formatINRShort(res.cm2_inputs.commission_total)} ·{" "}
					{res.cm2_inputs.commission_accounts.length} acc · schemes{" "}
					{formatINRShort(res.cm2_inputs.scheme_total)} ·{" "}
					{res.cm2_inputs.scheme_accounts.length} acc
				</div>
				<div>
					<span className="font-semibold text-text-2">CM3:</span> marketing{" "}
					{formatINRShort(res.cm3_inputs.marketing_total)} ·{" "}
					{res.cm3_inputs.marketing_accounts.length} acc
				</div>
				<div>
					<span className="font-semibold text-text-2">EBITDA:</span> salary{" "}
					{formatINRShort(res.ladder_inputs.salary_total)} ·{" "}
					{res.ladder_inputs.salary_accounts.length} acc · rent{" "}
					{formatINRShort(res.ladder_inputs.rent_total)} ·{" "}
					{res.ladder_inputs.rent_accounts.length} acc · utilities{" "}
					{formatINRShort(res.ladder_inputs.utility_total)} ·{" "}
					{res.ladder_inputs.utility_accounts.length} acc · admin{" "}
					{formatINRShort(res.ladder_inputs.admin_total)} ·{" "}
					{res.ladder_inputs.admin_accounts.length} acc
				</div>
				<div>
					<span className="font-semibold text-text-2">EBIT/PAT:</span> D&A{" "}
					{formatINRShort(res.ladder_inputs.da_total)} ·{" "}
					{res.ladder_inputs.da_accounts.length} acc · interest{" "}
					{formatINRShort(res.ladder_inputs.interest_total)} ·{" "}
					{res.ladder_inputs.interest_accounts.length} acc · tax{" "}
					{formatINRShort(res.ladder_inputs.tax_total)} ·{" "}
					{res.ladder_inputs.tax_accounts.length} acc
				</div>
				<div>
					<span className="font-semibold text-text-2">Basis:</span>{" "}
					{res.cm2_inputs.allocation_basis} · scope {res.cm2_inputs.company_scope} · edit
					in{" "}
					<a
						href="/app/company-dashboard-settings"
						className="text-green font-medium underline-offset-2 hover:underline"
					>
						Company Dashboard Settings
					</a>
					.
				</div>
			</div>

			{kpi.unclassified_revenue > kpi.total_revenue * 0.1 && (
				<div className="mt-4 px-4 py-3 rounded-lg bg-amber-bg border border-amber/20 text-amber text-[12px] leading-relaxed flex items-start gap-2.5">
					<span className="mt-0.5 shrink-0 w-4 h-4 rounded-full bg-amber text-white text-[10px] font-bold flex items-center justify-center">
						!
					</span>
					<div>
						<strong className="font-semibold">Heads up: </strong>
						{formatINRShort(kpi.unclassified_revenue)} (
						{Math.round((kpi.unclassified_revenue / (kpi.total_revenue || 1)) * 100)}%) of
						revenue is on items without a{" "}
						<code className="px-1 py-0.5 rounded bg-amber/10 text-[11px]">
							custom_sales_intent
						</code>{" "}
						set. Fill those in on the Item form to tighten the B2C/B2B split.
					</div>
				</div>
			)}

			<div className="grid grid-cols-[1.6fr_1fr] gap-4 mt-4">
				<div className="card">
					<div className="flex items-center justify-between mb-4">
						<div>
							<div className="card-title mb-0.5">Monthly revenue</div>
							<div className="text-[11px] text-text-3 font-medium">
								B2C vs B2B · ₹L · {taxLabel}
							</div>
						</div>
						<span className="badge bg-green-bg text-green font-semibold">
							<span className="w-1.5 h-1.5 rounded-full bg-green mr-1.5 animate-pulse" />
							Live ERPNext
						</span>
					</div>
					{monthly.length === 0 ? (
						<EmptyState message="No Sales Invoice data in the trailing 12 months." />
					) : (
						<RevenueTrendChart data={monthly} />
					)}
				</div>
				<div className="flex flex-col gap-4">
					<div className="card flex-1">
						<div className="card-title">Revenue mix</div>
						<RevenueMixChart b2c={kpi.b2c_revenue} b2b={kpi.b2b_revenue} />
					</div>
					<div className="card flex-1">
						<div className="flex items-center justify-between mb-3">
							<div className="card-title mb-0">Revenue by category</div>
							<span className="text-[9.5px] tracking-[0.1em] uppercase text-text-3 font-medium">
								Top 10 + Other
							</span>
						</div>
						{categories.length === 0 ? (
							<EmptyState message="No Item Group data yet." />
						) : (
							<CategoryTable data={categories} />
						)}
					</div>
				</div>
			</div>
		</>
	);
}

function LoadingShell({
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
}: {
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
}) {
	return (
		<div className="animate-pulse space-y-4">
			<div className="flex justify-between items-start">
				<div className="h-10 w-72 bg-surface-2 rounded" />
				<div className="flex items-center gap-2">
					<PeriodPicker value={period} onChange={onPeriodChange} />
					<TaxModeTabs value={taxMode} onChange={onTaxModeChange} />
				</div>
			</div>
			<div className="grid grid-cols-5 gap-2.5">
				{Array.from({ length: 5 }).map((_, i) => (
					<div key={i} className="h-24 bg-surface-2 rounded-[12px]" />
				))}
			</div>
			<div className="grid grid-cols-5 gap-2.5">
				{Array.from({ length: 5 }).map((_, i) => (
					<div key={i} className="h-24 bg-surface-2 rounded-[12px]" />
				))}
			</div>
			<div className="h-64 bg-surface-2 rounded-[12px]" />
		</div>
	);
}

function ErrorShell({ message }: { message: string }) {
	return (
		<div className="card">
			<div className="card-title text-red">Unable to load MIS data</div>
			<p className="text-[12px] text-text-2">{message}</p>
			<p className="text-[12px] text-text-3 mt-3">
				If ERPNext isn't installed on this site, the Overview cannot resolve Sales Invoice
				data. Install ERPNext or switch to a site that has it, then reload.
			</p>
		</div>
	);
}

function EmptyState({ message }: { message: string }) {
	return (
		<div className="h-[140px] flex items-center justify-center text-[12px] text-text-3">
			{message}
		</div>
	);
}
