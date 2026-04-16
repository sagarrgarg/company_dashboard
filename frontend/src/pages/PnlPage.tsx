import { useEffect, useState } from "react";
import { PeriodPicker } from "@/components/widgets/PeriodPicker";
import { TaxModeTabs } from "@/components/widgets/TaxModeTabs";
import { DownloadButtons } from "@/components/widgets/DownloadButtons";
import { PnlTable } from "@/components/widgets/PnlTable";
import { PnlWaterfallChart } from "@/components/widgets/PnlWaterfallChart";
import { useOverview } from "@/hooks/useOverview";
import { buildPnlSteps, type PnlBucket } from "@/lib/pnl";
import { cn, formatINRShort, formatPct } from "@/lib/utils";
import type { PeriodSelection, TaxMode } from "@/types/mis";

interface Props {
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
	onCompanyResolved?: (company: string) => void;
}

const BUCKETS: Array<{ key: PnlBucket; label: string }> = [
	{ key: "overall", label: "Total" },
	{ key: "b2c", label: "B2C" },
	{ key: "b2b", label: "B2B" },
];

export function PnlPage({
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
	onCompanyResolved,
}: Props) {
	const [bucket, setBucket] = useState<PnlBucket>("overall");
	const { data, error, isLoading } = useOverview(taxMode, period);
	const res = data?.message;

	useEffect(() => {
		if (res?.company) onCompanyResolved?.(res.company);
	}, [res?.company, onCompanyResolved]);

	if (isLoading && !res) {
		return (
			<Shell taxMode={taxMode} onTaxModeChange={onTaxModeChange} period={period} onPeriodChange={onPeriodChange}>
				<div className="animate-pulse space-y-4">
					<div className="h-24 bg-surface-2 rounded-[12px]" />
					<div className="h-96 bg-surface-2 rounded-[12px]" />
				</div>
			</Shell>
		);
	}
	if (error || !res) {
		return (
			<Shell taxMode={taxMode} onTaxModeChange={onTaxModeChange} period={period} onPeriodChange={onPeriodChange}>
				<div className="card">
					<div className="card-title text-red">Unable to load P&L</div>
					<p className="text-[12px] text-text-2">{error?.message ?? "No data"}</p>
				</div>
			</Shell>
		);
	}

	const steps = buildPnlSteps(res, bucket);
	const revenue = steps[0]?.subtotal ?? 0;
	const pat = steps[steps.length - 1]?.subtotal ?? 0;
	const patPct = revenue ? (pat / revenue) * 100 : 0;
	const taxLabel = taxMode === "incl" ? "Tax-inclusive" : "Tax-exclusive";

	return (
		<Shell
			taxMode={taxMode}
			onTaxModeChange={onTaxModeChange}
			period={period}
			onPeriodChange={onPeriodChange}
			company={res.company}
			subtitle={`${res.period.label} · ${taxLabel}`}
			totals={{ revenue, pat, patPct }}
		>
			<div className="flex items-center gap-1 p-1 rounded-full border border-border-md bg-surface w-fit mb-4 shadow-[0_1px_2px_rgba(40,30,15,.05)]">
				{BUCKETS.map((b) => (
					<button
						key={b.key}
						type="button"
						onClick={() => setBucket(b.key)}
						className={cn(
							"px-3.5 py-[5px] text-[11px] font-semibold rounded-full transition-all tracking-wide",
							bucket === b.key
								? "bg-green text-white shadow-[0_1px_2px_rgba(31,95,51,.25)]"
								: "text-text-2 hover:bg-surface-2",
						)}
					>
						{b.label}
					</button>
				))}
			</div>

			<div className="grid grid-cols-[1.4fr_1fr] gap-4">
				<div className="card">
					<div className="flex items-center justify-between mb-3">
						<div>
							<div className="card-title mb-0.5">P&amp;L Waterfall</div>
							<div className="text-[11px] text-text-3 font-medium">
								Revenue → PAT · {BUCKETS.find((b) => b.key === bucket)?.label}
							</div>
						</div>
					</div>
					<PnlWaterfallChart steps={steps} />
				</div>
				<PnlTable steps={steps} />
			</div>
		</Shell>
	);
}

function Shell({
	taxMode,
	onTaxModeChange,
	period,
	onPeriodChange,
	company,
	subtitle,
	totals,
	children,
}: {
	taxMode: TaxMode;
	onTaxModeChange: (mode: TaxMode) => void;
	period: PeriodSelection;
	onPeriodChange: (next: PeriodSelection) => void;
	company?: string;
	subtitle?: string;
	totals?: { revenue: number; pat: number; patPct: number };
	children: React.ReactNode;
}) {
	return (
		<>
			<header className="flex justify-between items-start mb-7 gap-4">
				<div>
					<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-green mb-1">
						P&amp;L Waterfall
					</div>
					<h1 className="font-serif text-[28px] leading-[1.1] text-text tracking-tight">
						{company ?? "Profit & Loss"}
					</h1>
					{subtitle && (
						<div className="text-[12px] text-text-2 mt-1.5 font-medium">{subtitle}</div>
					)}
				</div>
				<div className="flex flex-col items-end gap-2.5">
					<div className="flex items-center gap-2 flex-wrap justify-end">
						<DownloadButtons taxMode={taxMode} period={period} />
						<PeriodPicker value={period} onChange={onPeriodChange} />
						<TaxModeTabs value={taxMode} onChange={onTaxModeChange} />
					</div>
					{totals && (
						<div className="text-right">
							<div className="text-[10px] font-semibold tracking-[0.12em] uppercase text-text-3">
								PAT
							</div>
							<div
								className={cn(
									"text-[30px] font-semibold leading-[1.05] tracking-tight tabular-nums",
									totals.pat >= 0 ? "text-text" : "text-red",
								)}
							>
								{formatINRShort(totals.pat)}
							</div>
							<div
								className={cn(
									"text-[12px] font-medium tabular-nums",
									totals.patPct >= 0 ? "text-green" : "text-red",
								)}
							>
								{formatPct(totals.patPct)} of revenue
							</div>
						</div>
					)}
				</div>
			</header>
			{children}
		</>
	);
}
