import { useCallback, useEffect, useRef, useState } from "react";
import { FrappeProvider } from "frappe-react-sdk";
import { Navigate, Route, Routes, BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/layout/Sidebar";
import { OverviewPage } from "@/pages/OverviewPage";
import { PnlPage } from "@/pages/PnlPage";
import { AssortmentPage } from "@/pages/AssortmentPage";
import { CustomerSegmentsPage } from "@/pages/CustomerSegmentsPage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { WorkingCapitalPage } from "@/pages/WorkingCapitalPage";
import { useUiFlags } from "@/hooks/useUiFlags";
import { bootDefaultCompany, type DashboardSections } from "@/lib/boot";
import type { MisQuery } from "@/hooks/useOverview";
import type { PeriodSelection, TaxMode } from "@/types/mis";

const TAX_MODE_KEY = "mis.tax_mode";
const PERIOD_KEY = "mis.period";

/** Props every MIS page receives from App. */
export interface MisPageProps {
	query: MisQuery;
	onTaxModeChange: (mode: TaxMode) => void;
	onPeriodChange: (next: PeriodSelection) => void;
	/** Called after a successful load — confirms the period (persisted) and the company. */
	onLoaded: (company: string) => void;
	onRefreshed: () => void;
}

function readInitialTaxMode(): TaxMode {
	try {
		const v = localStorage.getItem(TAX_MODE_KEY);
		if (v === "incl" || v === "excl") return v;
	} catch {
		/* localStorage blocked — use default */
	}
	// Default is tax-exclusive: every margin is ex-tax, so revenue matches it by default.
	return "excl";
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

function persistPeriod(p: PeriodSelection) {
	try {
		localStorage.setItem(PERIOD_KEY, JSON.stringify(p));
	} catch {
		/* ignore */
	}
}

function defaultRoute(sections: DashboardSections): string {
	if (sections.mis) return "/mis";
	if (sections.wc) return "/wc";
	return "/mis";
}

export default function App() {
	return (
		// url "" → same origin. In Vite dev that is :8082, which proxies /api to bench, so
		// the session cookie and CSRF token from get_context_for_dev both apply.
		<FrappeProvider url="">
			<BrowserRouter basename="/bizdashboard">
				<Dashboard />
				<Toaster position="bottom-right" richColors closeButton />
			</BrowserRouter>
		</FrappeProvider>
	);
}

/** Everything that needs the Frappe context (hooks) lives below the provider. */
function Dashboard() {
	// Company sent to the API ("" = server default). Only the selector changes it, so
	// resolving the default never re-keys the requests.
	const [company, setCompany] = useState<string>(bootDefaultCompany);
	const [resolvedCompany, setResolvedCompany] = useState<string>(bootDefaultCompany);
	const [taxMode, setTaxModeState] = useState<TaxMode>(readInitialTaxMode);
	const [period, setPeriodState] = useState<PeriodSelection>(readInitialPeriod);
	const [misRefreshKey, setMisRefreshKey] = useState(0);
	const [wcRefreshKey, setWcRefreshKey] = useState(0);
	const { sections } = useUiFlags();

	const periodRef = useRef(period);
	periodRef.current = period;

	const onMisRefreshed = useCallback(() => setMisRefreshKey((k) => k + 1), []);
	const onWcRefreshed = useCallback(() => setWcRefreshKey((k) => k + 1), []);

	const setTaxMode = useCallback((mode: TaxMode) => {
		setTaxModeState(mode);
		try {
			localStorage.setItem(TAX_MODE_KEY, mode);
		} catch {
			/* ignore */
		}
	}, []);

	// A period is only persisted once a page has loaded with it (onLoaded), so a range
	// that errors is not restored on the next visit.
	const setPeriod = useCallback((next: PeriodSelection) => {
		setPeriodState(next);
		if (next.kind === "ttm") persistPeriod(next);
	}, []);

	const onLoaded = useCallback((c: string) => {
		persistPeriod(periodRef.current);
		if (c) setResolvedCompany(c);
	}, []);

	const onCompanyChange = useCallback((c: string) => {
		setCompany(c);
		setResolvedCompany(c);
	}, []);

	const displayCompany = resolvedCompany || company;

	useEffect(() => {
		document.title = displayCompany ? `${displayCompany} · Biz Dashboard` : "Biz Dashboard";
	}, [displayCompany]);

	const misProps: MisPageProps = {
		query: { taxMode, period, company, refreshKey: misRefreshKey },
		onTaxModeChange: setTaxMode,
		onPeriodChange: setPeriod,
		onLoaded,
		onRefreshed: onMisRefreshed,
	};

	return (
		<div className="min-h-screen bg-bg">
			<Sidebar
				company={displayCompany}
				selectedCompany={company}
				onCompanyChange={onCompanyChange}
				period={period}
				sections={sections}
			/>
			<div className="ml-[230px] px-8 py-7 min-h-screen">
				<Routes>
					<Route
						path="/"
						element={<Navigate to={defaultRoute(sections)} replace />}
					/>

					{/* ── MIS section ── */}
					{sections.mis && (
						<>
							<Route path="/mis" element={<OverviewPage {...misProps} />} />
							<Route path="/mis/pnl" element={<PnlPage {...misProps} />} />
							<Route path="/mis/assortment" element={<AssortmentPage {...misProps} />} />
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
							<Route path="/mis/segments" element={<CustomerSegmentsPage {...misProps} />} />
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
						<Route
							path="/wc"
							element={
								<WorkingCapitalPage
									company={company}
									refreshKey={wcRefreshKey}
									onRefreshed={onWcRefreshed}
									onLoaded={onLoaded}
								/>
							}
						/>
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
	);
}
