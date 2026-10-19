/** URL-carried dashboard state: period, tax mode and company live in the query string so
 *  any page (and any drill page opened in a new tab) reproduces the same view.
 *
 *    ?period=ttm
 *    ?period=fy&fy=<name>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *    ?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 *    &tax=excl|incl  &company=<name>
 *
 *  The URL wins over localStorage; localStorage is only the default when the URL has no
 *  state. Control changes rewrite the URL with replace semantics, so the back button
 *  walks pages, not filter tweaks. */
import { createContext, useCallback, useContext, useMemo } from "react";
import { useSearchParams, type To } from "react-router-dom";
import type { PeriodSelection, TaxMode } from "@/types/mis";

/** BrowserRouter basename — absolute hrefs (new-tab links) need it. */
export const BASENAME = "/bizdashboard";

/** Query keys owned by the dashboard state (everything else is page-specific). */
export const STATE_KEYS = ["period", "fy", "from", "to", "tax", "company"] as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface DashState {
	period: PeriodSelection;
	taxMode: TaxMode;
	/** "" = server default company. */
	company: string;
}

/** Whatever valid state the URL carries (missing / malformed keys are omitted). */
export function readStateFromSearch(sp: URLSearchParams): Partial<DashState> {
	const out: Partial<DashState> = {};
	const kind = sp.get("period");
	const from = sp.get("from") ?? "";
	const to = sp.get("to") ?? "";
	const rangeOk = ISO.test(from) && ISO.test(to) && from <= to;
	if (kind === "ttm") out.period = { kind: "ttm" };
	else if (kind === "fy" && sp.get("fy") && rangeOk) out.period = { kind: "fy", name: sp.get("fy")!, from, to };
	else if (kind === "custom" && rangeOk) out.period = { kind: "custom", from, to };
	const tax = sp.get("tax");
	if (tax === "excl" || tax === "incl") out.taxMode = tax;
	const company = sp.get("company");
	if (company) out.company = company;
	return out;
}

/** Copy of `base` with the dashboard state written into it (other keys kept). */
export function writeStateToSearch(base: URLSearchParams, s: DashState): URLSearchParams {
	const sp = new URLSearchParams(base);
	for (const k of STATE_KEYS) sp.delete(k);
	sp.set("period", s.period.kind);
	if (s.period.kind === "fy") sp.set("fy", s.period.name);
	if (s.period.kind !== "ttm") {
		sp.set("from", s.period.from);
		sp.set("to", s.period.to);
	}
	sp.set("tax", s.taxMode);
	if (s.company) sp.set("company", s.company);
	return sp;
}

export type ExtraParams = Record<string, string | number | null | undefined | false>;

function applyExtra(sp: URLSearchParams, extra?: ExtraParams): URLSearchParams {
	if (!extra) return sp;
	for (const [k, v] of Object.entries(extra)) {
		if (v === null || v === undefined || v === false || v === "") sp.delete(k);
		else sp.set(k, String(v));
	}
	return sp;
}

/* ── Context ────────────────────────────────────────────────────────────── */

export interface DashStateApi extends DashState {
	/** Company the server resolved (shown + carried into new-tab links). */
	resolvedCompany: string;
	/** Full in-app href (with basename) carrying the state + extra params — for
	 *  `<a href target="_blank">` new-tab links. */
	buildHref: (path: string, extra?: ExtraParams) => string;
	/** Router location carrying the state + extra params — for same-tab `<Link to>`
	 *  (drill levels push history so Back walks back up). */
	drillTo: (path: string, extra?: ExtraParams) => To;
	/** Query string ("?…") of the current state only (sidebar links). */
	stateSearch: string;
}

export const DashStateContext = createContext<DashStateApi | null>(null);

export function useDashState(): DashStateApi {
	const ctx = useContext(DashStateContext);
	if (!ctx) throw new Error("useDashState outside DashStateContext");
	return ctx;
}

/** `buildHref(path, extra)` → "/bizdashboard/mis/line/cm2?period=…&bucket=b2c". */
export function useDrillHref() {
	return useDashState().buildHref;
}

/** Build the context value (used once, in App). */
export function useDashStateApi(state: DashState, resolvedCompany: string): DashStateApi {
	const { period, taxMode, company } = state;
	return useMemo(() => {
		const carried: DashState = { period, taxMode, company: company || resolvedCompany };
		const search = (extra?: ExtraParams) =>
			applyExtra(writeStateToSearch(new URLSearchParams(), carried), extra).toString();
		return {
			period,
			taxMode,
			company,
			resolvedCompany,
			buildHref: (path, extra) => `${BASENAME}${path}?${search(extra)}`,
			drillTo: (path, extra) => ({ pathname: path, search: `?${search(extra)}` }),
			stateSearch: `?${search()}`,
		};
	}, [period, taxMode, company, resolvedCompany]);
}

/** A page-level query param (bucket, intent, sort…) with replace-semantics updates.
 *  Values outside `allowed` fall back to `fallback`. */
export function useUrlParam<T extends string>(
	name: string,
	fallback: T,
	allowed?: readonly T[],
): [T, (next: T) => void] {
	const [sp, setSp] = useSearchParams();
	const raw = sp.get(name);
	const value = (raw && (!allowed || (allowed as readonly string[]).includes(raw)) ? raw : fallback) as T;
	const set = useCallback(
		(next: T) => {
			setSp(
				(prev) => {
					const p = new URLSearchParams(prev);
					if (next === fallback) p.delete(name);
					else p.set(name, next);
					return p;
				},
				{ replace: true },
			);
		},
		[name, fallback, setSp],
	);
	return [value, set];
}

/** Numeric variant (pagination offsets). */
export function useUrlNumber(name: string, fallback = 0): [number, (next: number) => void] {
	const [raw, setRaw] = useUrlParam<string>(name, String(fallback));
	const n = Number(raw);
	const value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
	const set = useCallback((next: number) => setRaw(String(next)), [setRaw]);
	return [value, set];
}

/** Patch several page params at once (replace). react-router's setSearchParams reads the
 *  params of the last render, so two setters in one tick would overwrite each other —
 *  use this when a change resets another param (e.g. sort → start=0). */
export function useUrlPatch(): (patch: ExtraParams) => void {
	const [, setSp] = useSearchParams();
	return useCallback(
		(patch: ExtraParams) => setSp((prev) => applyExtra(new URLSearchParams(prev), patch), { replace: true }),
		[setSp],
	);
}
