import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FrappeProvider } from "frappe-react-sdk";
import { Navigate, Route, Routes, BrowserRouter, useLocation, useSearchParams } from "react-router-dom";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/layout/Sidebar";
import { OverviewPage } from "@/pages/OverviewPage";
import { PnlPage } from "@/pages/PnlPage";
import { AssortmentPage } from "@/pages/AssortmentPage";
import { CustomerSegmentsPage } from "@/pages/CustomerSegmentsPage";
import { ComingSoonPage } from "@/pages/ComingSoonPage";
import { WorkingCapitalPage } from "@/pages/WorkingCapitalPage";
import { LineDrillPage } from "@/pages/drill/LineDrillPage";
import { AccountDrillPage } from "@/pages/drill/AccountDrillPage";
import { RevenueDrillPage } from "@/pages/drill/RevenueDrillPage";
import { PnlStatementPage } from "@/pages/statements/PnlStatementPage";
import { BalanceSheetPage } from "@/pages/statements/BalanceSheetPage";
import { CashFlowPage } from "@/pages/statements/CashFlowPage";
import { RatiosPage } from "@/pages/statements/RatiosPage";
import { ControlsPage } from "@/pages/statements/ControlsPage";
import { AlertsPage } from "@/pages/statements/AlertsPage";
import { ControlsBadge, useStatementBadges } from "@/components/statements/StatementBits";
import { ExplainProvider } from "@/components/explain/Explain";
import {
	BASENAME,
	DashStateContext,
	readStateFromSearch,
	useDashStateApi,
	writeStateToSearch,
	type DashState,
} from "@/lib/urlState";
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
			<BrowserRouter basename={BASENAME}>
				<ExplainProvider>
					<Dashboard />
				</ExplainProvider>
				<Toaster position="bottom-right" richColors closeButton />
			</BrowserRouter>
		</FrappeProvider>
	);
}

/** Everything that needs the Frappe context (hooks) lives below the provider. */
function Dashboard() {
	// Period, tax mode and company live in the URL (A1). localStorage / boot only supply
	// the defaults when the URL carries no state — the URL always wins.
	const [searchParams, setSearchParams] = useSearchParams();
	const fallback = useRef<DashState>({
		period: readInitialPeriod(),
		taxMode: readInitialTaxMode(),
		company: bootDefaultCompany(),
	});
	const fromUrl = useMemo(() => readStateFromSearch(searchParams), [searchParams]);
	const periodKey = JSON.stringify(fromUrl.period ?? fallback.current.period);
	// Stable identities, so a page-only param change (bucket, sort…) doesn't re-key anything.
	const period = useMemo(() => JSON.parse(periodKey) as PeriodSelection, [periodKey]);
	const taxMode: TaxMode = fromUrl.taxMode ?? fallback.current.taxMode;
	// Company sent to the API ("" = server default). Resolving the default never re-keys
	// the requests; only the selector (or a URL) changes it.
	const company = fromUrl.company ?? fallback.current.company;
	const [resolvedCompany, setResolvedCompany] = useState<string>(bootDefaultCompany);
	const [misRefreshKey, setMisRefreshKey] = useState(0);
	const [wcRefreshKey, setWcRefreshKey] = useState(0);
	const [navOpen, setNavOpen] = useState(false);
	const { sections } = useUiFlags();
	const location = useLocation();

	const stateRef = useRef<DashState>({ period, taxMode, company });
	stateRef.current = { period, taxMode, company };

	/** Write the dashboard state into the URL (replace — filter tweaks aren't history). */
	const writeUrl = useCallback(
		(patch: Partial<DashState>) => {
			setSearchParams(
				(prev) => {
					const next = writeStateToSearch(prev, { ...stateRef.current, ...patch });
					// A new period / company invalidates page offsets.
					if (patch.period || patch.company !== undefined) next.delete("start");
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	// Canonicalise: a URL without state gets the effective state, so it can be shared.
	useEffect(() => {
		if (!searchParams.get("period") || !searchParams.get("tax")) writeUrl({});
	}, [searchParams, writeUrl]);

	useEffect(() => setNavOpen(false), [location.pathname]);

	const onMisRefreshed = useCallback(() => setMisRefreshKey((k) => k + 1), []);
	const onWcRefreshed = useCallback(() => setWcRefreshKey((k) => k + 1), []);

	const setTaxMode = useCallback(
		(mode: TaxMode) => {
			writeUrl({ taxMode: mode });
			try {
				localStorage.setItem(TAX_MODE_KEY, mode);
			} catch {
				/* ignore */
			}
		},
		[writeUrl],
	);

	// A period is only persisted once a page has loaded with it (onLoaded), so a range
	// that errors is not restored on the next visit.
	const setPeriod = useCallback(
		(next: PeriodSelection) => {
			writeUrl({ period: next });
			if (next.kind === "ttm") persistPeriod(next);
		},
		[writeUrl],
	);

	const onLoaded = useCallback((c: string) => {
		persistPeriod(stateRef.current.period);
		if (c) setResolvedCompany(c);
	}, []);

	const onCompanyChange = useCallback(
		(c: string) => {
			writeUrl({ company: c });
			setResolvedCompany(c);
		},
		[writeUrl],
	);

	const displayCompany = resolvedCompany || company;
	const dashApi = useDashStateApi({ period, taxMode, company }, displayCompany);

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
		<DashStateContext.Provider value={dashApi}>
		<div className="min-h-screen bg-bg">
			<Sidebar
				company={displayCompany}
				selectedCompany={company}
				onCompanyChange={onCompanyChange}
				period={period}
				sections={sections}
				open={navOpen}
				onClose={() => setNavOpen(false)}
				refreshKey={misRefreshKey}
			/>
			<MobileTopBar company={displayCompany} onMenu={() => setNavOpen(true)} showControls={sections.mis} refreshKey={misRefreshKey} />
			<div className="lg:ml-[230px] px-4 sm:px-6 lg:px-8 py-5 lg:py-7 min-h-screen min-w-0">
				<Routes>
					<Route
						path="/"
						element={<Navigate to={{ pathname: defaultRoute(sections), search: location.search }} replace />}
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
							<Route path="/mis/line/:key" element={<LineDrillPage {...misProps} />} />
							<Route path="/mis/revenue" element={<RevenueDrillPage {...misProps} />} />
							{/* ── Statements ── */}
							<Route path="/mis/statement" element={<PnlStatementPage {...misProps} />} />
							<Route path="/mis/balance-sheet" element={<BalanceSheetPage {...misProps} />} />
							<Route path="/mis/cash-flow" element={<CashFlowPage {...misProps} />} />
							<Route path="/mis/ratios" element={<RatiosPage {...misProps} />} />
							<Route path="/mis/controls" element={<ControlsPage {...misProps} />} />
							<Route path="/mis/alerts" element={<AlertsPage {...misProps} />} />
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

					{/* Account drill: MIS users drill any account, WC-only users the Bank / Cash /
					    Receivable / Payable / Stock accounts (enforced by the API). */}
					{(sections.mis || sections.wc) && (
						<Route path="/mis/account/:account" element={<AccountDrillPage {...misProps} />} />
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
		</DashStateContext.Provider>
	);
}

/** Below lg the sidebar is a drawer; this bar opens it. */
function MobileTopBar({
	company,
	onMenu,
	showControls,
	refreshKey,
}: {
	company: string;
	onMenu: () => void;
	showControls: boolean;
	refreshKey: number;
}) {
	// Same (deduplicated) request as the sidebar badge; only MIS users can read controls.
	const { summary } = useStatementBadges(refreshKey, showControls);
	return (
		<div className="lg:hidden sticky top-0 z-40 flex items-center gap-3 px-4 h-12 bg-sidebar-bg" style={{ color: "var(--sidebar-text)" }}>
			<button
				type="button"
				onClick={onMenu}
				className="w-10 h-10 -ml-2 flex items-center justify-center rounded-lg"
				aria-label="Open navigation"
			>
				<svg className="w-5 h-5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
					<path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
				</svg>
			</button>
			<div className="font-serif text-[16px] truncate min-w-0 flex-1" style={{ color: "var(--sidebar-text-active)" }}>
				{company || "Biz Dashboard"}
			</div>
			{showControls && <ControlsBadge summary={summary} variant="dark" className="shrink-0 !min-h-[28px] !text-[10.5px]" />}
		</div>
	);
}
