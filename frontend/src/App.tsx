import { useCallback, useEffect, useMemo, useState } from "react";
import { FrappeProvider } from "frappe-react-sdk";
import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { OverviewPage } from "@/pages/OverviewPage";
import { PnlPage } from "@/pages/PnlPage";
import { AssortmentPage } from "@/pages/AssortmentPage";
import { CustomerSegmentsPage } from "@/pages/CustomerSegmentsPage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { WorkingCapitalPage } from "@/pages/WorkingCapitalPage";
import type { PeriodSelection, TaxMode } from "@/types/mis";

const TAX_MODE_KEY = "mis.tax_mode";
const PERIOD_KEY = "mis.period";

export interface DashboardSections {
	mis: boolean;
	wc: boolean;
}

function readBoot() {
	const boot = window.frappe?.boot as
		| { company_dashboard?: { default_company?: string; sections?: DashboardSections } }
		| undefined;
	return boot?.company_dashboard;
}

function readInitialCompany(): string {
	return readBoot()?.default_company ?? "";
}

function readSections(): DashboardSections {
	return readBoot()?.sections ?? { mis: true, wc: true };
}

function readInitialTaxMode(): TaxMode {
	try {
		const v = localStorage.getItem(TAX_MODE_KEY);
		if (v === "incl" || v === "excl") return v;
	} catch {
		/* localStorage blocked — use default */
	}
	return "incl";
}

function readInitialPeriod(): PeriodSelection {
	try {
		const raw = localStorage.getItem(PERIOD_KEY);
		if (!raw) return { kind: "ttm" };
		const parsed = JSON.parse(raw);
		if (parsed?.kind === "ttm") return { kind: "ttm" };
		if (parsed?.kind === "fy" && parsed.name && parsed.from && parsed.to) return parsed;
		if (parsed?.kind === "custom" && parsed.from && parsed.to) return parsed;
	} catch {
		/* bad JSON — reset */
	}
	return { kind: "ttm" };
}

function defaultRoute(sections: DashboardSections): string {
	if (sections.mis) return "/mis";
	if (sections.wc) return "/wc";
	return "/mis";
}

export default function App() {
	const [company, setCompany] = useState<string>(readInitialCompany);
	const [taxMode, setTaxModeState] = useState<TaxMode>(readInitialTaxMode);
	const [period, setPeriodState] = useState<PeriodSelection>(readInitialPeriod);
	const [misRefreshKey, setMisRefreshKey] = useState(0);
	const sections = useMemo(readSections, []);

	const onMisRefreshed = useCallback(() => setMisRefreshKey((k) => k + 1), []);

	const setTaxMode = useCallback((mode: TaxMode) => {
		setTaxModeState(mode);
		try {
			localStorage.setItem(TAX_MODE_KEY, mode);
		} catch {
			/* ignore */
		}
	}, []);

	const setPeriod = useCallback((next: PeriodSelection) => {
		setPeriodState(next);
		try {
			localStorage.setItem(PERIOD_KEY, JSON.stringify(next));
		} catch {
			/* ignore */
		}
	}, []);

	useEffect(() => {
		document.title = company ? `${company} · Biz Dashboard` : "Biz Dashboard";
	}, [company]);

	const companyCallback = useCallback(
		(c: string) => {
			if (c && c !== company) setCompany(c);
		},
		[company],
	);

	return (
		<FrappeProvider
			url={import.meta.env.DEV ? `http://${window.location.hostname}:8000` : ""}
		>
			<BrowserRouter basename="/bizdashboard">
				<div className="min-h-screen bg-bg">
					<Sidebar company={company} sections={sections} />
					<div className="ml-[230px] px-8 py-7 min-h-screen">
						<Routes>
							<Route
								path="/"
								element={<Navigate to={defaultRoute(sections)} replace />}
							/>

							{/* ── MIS section ── */}
							{sections.mis && (
								<>
									<Route
										path="/mis"
										element={
											<OverviewPage
												taxMode={taxMode}
												onTaxModeChange={setTaxMode}
												period={period}
												onPeriodChange={setPeriod}
												onCompanyResolved={companyCallback}
												refreshKey={misRefreshKey}
												onRefreshed={onMisRefreshed}
											/>
										}
									/>
									<Route
										path="/mis/pnl"
										element={
											<PnlPage
												taxMode={taxMode}
												onTaxModeChange={setTaxMode}
												period={period}
												onPeriodChange={setPeriod}
												onCompanyResolved={companyCallback}
												refreshKey={misRefreshKey}
												onRefreshed={onMisRefreshed}
											/>
										}
									/>
									<Route
										path="/mis/assortment"
										element={
											<AssortmentPage
												taxMode={taxMode}
												onTaxModeChange={setTaxMode}
												period={period}
												onPeriodChange={setPeriod}
												onCompanyResolved={companyCallback}
												refreshKey={misRefreshKey}
												onRefreshed={onMisRefreshed}
											/>
										}
									/>
									<Route
										path="/mis/sku"
										element={
											<ComingSoonPage
												title="SKU Analysis"
												phase="Phase 3"
												description="Price architecture, price-per-gram, COGS composition by category."
											/>
										}
									/>
									<Route
										path="/mis/segments"
										element={
											<CustomerSegmentsPage
												taxMode={taxMode}
												onTaxModeChange={setTaxMode}
												period={period}
												onPeriodChange={setPeriod}
												onCompanyResolved={companyCallback}
												refreshKey={misRefreshKey}
												onRefreshed={onMisRefreshed}
											/>
										}
									/>
									<Route
										path="/mis/tam"
										element={
											<ComingSoonPage
												title="TAM — Market Sizing"
												phase="Phase 3"
												description="Fed from a MIS Settings doctype — admin-editable market constants."
											/>
										}
									/>
								</>
							)}

							{/* ── Working Capital section ── */}
							{sections.wc && (
								<Route path="/wc" element={<WorkingCapitalPage />} />
							)}

							<Route
								path="*"
								element={
									<div className="card">
										<div className="card-title">Not found</div>
										<p className="text-[13px] text-text-2">
											No page at this route.
										</p>
									</div>
								}
							/>
						</Routes>
					</div>
				</div>
			</BrowserRouter>
		</FrappeProvider>
	);
}
