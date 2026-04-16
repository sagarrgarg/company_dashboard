import { useCallback, useEffect, useState } from "react";
import { FrappeProvider } from "frappe-react-sdk";
import { Route, Routes, BrowserRouter } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { OverviewPage } from "@/pages/OverviewPage";
import { PnlPage } from "@/pages/PnlPage";
import { AssortmentPage } from "@/pages/AssortmentPage";
import { CustomerSegmentsPage } from "@/pages/CustomerSegmentsPage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import type { PeriodSelection, TaxMode } from "@/types/mis";

const TAX_MODE_KEY = "mis.tax_mode";
const PERIOD_KEY = "mis.period";

function readInitialCompany(): string {
	const boot = window.frappe?.boot as
		| { company_dashboard?: { default_company?: string } }
		| undefined;
	return boot?.company_dashboard?.default_company ?? "";
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

export default function App() {
	const [company, setCompany] = useState<string>(readInitialCompany);
	const [taxMode, setTaxModeState] = useState<TaxMode>(readInitialTaxMode);
	const [period, setPeriodState] = useState<PeriodSelection>(readInitialPeriod);

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
		document.title = company ? `${company} · MIS` : "MIS · Company Dashboard";
	}, [company]);

	return (
		<FrappeProvider
			url={import.meta.env.DEV ? `http://${window.location.hostname}:8000` : ""}
		>
			<BrowserRouter basename="/mis">
				<div className="min-h-screen bg-bg">
					<Sidebar company={company} />
					<div className="ml-[230px] px-8 py-7 min-h-screen">
						<Routes>
							<Route
								path="/"
								element={
									<OverviewPage
										taxMode={taxMode}
										onTaxModeChange={setTaxMode}
										period={period}
										onPeriodChange={setPeriod}
										onCompanyResolved={(c) => {
											if (c && c !== company) setCompany(c);
										}}
									/>
								}
							/>
							<Route
								path="/pnl"
								element={
									<PnlPage
										taxMode={taxMode}
										onTaxModeChange={setTaxMode}
										period={period}
										onPeriodChange={setPeriod}
										onCompanyResolved={(c) => {
											if (c && c !== company) setCompany(c);
										}}
									/>
								}
							/>
							<Route
								path="/assortment"
								element={
									<AssortmentPage
										taxMode={taxMode}
										onTaxModeChange={setTaxMode}
										period={period}
										onPeriodChange={setPeriod}
										onCompanyResolved={(c) => {
											if (c && c !== company) setCompany(c);
										}}
									/>
								}
							/>
							<Route
								path="/sku"
								element={
									<ComingSoonPage
										title="SKU Analysis"
										phase="Phase 3"
										description="Price architecture, price-per-gram, COGS composition by category."
									/>
								}
							/>
							<Route
								path="/segments"
								element={
									<CustomerSegmentsPage
										taxMode={taxMode}
										onTaxModeChange={setTaxMode}
										period={period}
										onPeriodChange={setPeriod}
										onCompanyResolved={(c) => {
											if (c && c !== company) setCompany(c);
										}}
									/>
								}
							/>
							<Route
								path="/tam"
								element={
									<ComingSoonPage
										title="TAM — Market Sizing"
										phase="Phase 3"
										description="Fed from a MIS Settings doctype — admin-editable market constants."
									/>
								}
							/>
							<Route
								path="/wc"
								element={
									<ComingSoonPage
										title="Working Capital"
										phase="Phase 2"
										description="DSO · DPO · DIO · CCC — from AR/AP aging and stock valuation."
									/>
								}
							/>
							<Route
								path="*"
								element={
									<div className="card">
										<div className="card-title">Not found</div>
										<p className="text-[13px] text-text-2">
											No MIS page at this route.
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
