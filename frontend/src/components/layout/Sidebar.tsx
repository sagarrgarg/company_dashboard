import { NavLink } from "react-router-dom";
import { cn, describePeriod } from "@/lib/utils";
import { useCompanies } from "@/hooks/useOverview";
import { useDashState } from "@/lib/urlState";
import type { DashboardSections } from "@/lib/boot";
import type { PeriodSelection } from "@/types/mis";
import { ControlsBadge, controlsText, useStatementBadges } from "@/components/statements/StatementBits";

interface NavItem {
	to: string;
	label: string;
	icon: React.ReactNode;
	group: string;
	section: "mis" | "wc";
	disabled?: boolean;
	/** Live count shown on the link. */
	badge?: "controls" | "alerts";
}

const ICON = (path: React.ReactNode) => (
	<svg className="w-[15px] h-[15px] shrink-0 opacity-75" viewBox="0 0 16 16" fill="none">
		{path}
	</svg>
);

const ITEMS: NavItem[] = [
	{
		group: "Overview",
		section: "mis",
		to: "/mis",
		label: "Overview",
		icon: ICON(
			<>
				<rect x="1" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".9" />
				<rect x="9" y="1" width="6" height="6" rx="1.5" fill="currentColor" opacity=".9" />
				<rect x="1" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".9" />
				<rect x="9" y="9" width="6" height="6" rx="1.5" fill="currentColor" opacity=".9" />
			</>,
		),
	},
	{
		group: "Revenue",
		section: "mis",
		to: "/mis/pnl",
		label: "P&L Waterfall",
		icon: ICON(
			<polyline
				points="2,13 5,9 8,11 11,6 14,3"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>,
		),
	},
	{
		group: "Assortment",
		section: "mis",
		to: "/mis/assortment",
		label: "SKU Assortment",
		icon: ICON(
			<>
				<rect x="1" y="1" width="14" height="3" rx="1" fill="currentColor" opacity=".7" />
				<rect x="1" y="6" width="10" height="3" rx="1" fill="currentColor" opacity=".7" />
				<rect x="1" y="11" width="12" height="3" rx="1" fill="currentColor" opacity=".7" />
			</>,
		),
	},
	{
		group: "Assortment",
		section: "mis",
		to: "/mis/sku",
		label: "SKU Analysis",
		disabled: true,
		icon: ICON(
			<>
				<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
				<path d="M8 2A6 6 0 0 1 14 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
			</>,
		),
	},
	{
		group: "Channel & Market",
		section: "mis",
		to: "/mis/segments",
		label: "Customer Segments",
		icon: ICON(
			<>
				<circle cx="5" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
				<circle cx="11" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
				<path
					d="M1.5 14c.4-2 1.8-3.2 3.5-3.2s3.1 1.2 3.5 3.2"
					stroke="currentColor"
					strokeWidth="1.4"
					fill="none"
					strokeLinecap="round"
				/>
				<path
					d="M7.5 14c.4-2 1.8-3.2 3.5-3.2s3.1 1.2 3.5 3.2"
					stroke="currentColor"
					strokeWidth="1.4"
					fill="none"
					strokeLinecap="round"
				/>
			</>,
		),
	},
	{
		group: "Channel & Market",
		section: "mis",
		to: "/mis/tam",
		label: "TAM View",
		disabled: true,
		icon: ICON(
			<>
				<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
				<circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.5" />
			</>,
		),
	},
	{
		group: "Statements",
		section: "mis",
		to: "/mis/statement",
		label: "P&L statement",
		icon: ICON(
			<>
				<rect x="2" y="1.5" width="12" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
				<path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
			</>,
		),
	},
	{
		group: "Statements",
		section: "mis",
		to: "/mis/balance-sheet",
		label: "Balance sheet",
		icon: ICON(
			<>
				<path d="M8 2v12M3 14h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				<path d="M2 6l2.5-3L7 6a2.5 2.5 0 0 1-5 0zM9 6l2.5-3L14 6a2.5 2.5 0 0 1-5 0z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
			</>,
		),
	},
	{
		group: "Statements",
		section: "mis",
		to: "/mis/cash-flow",
		label: "Cash flow",
		icon: ICON(
			<>
				<path d="M2 5h10l-2.5-2.5M14 11H4l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
			</>,
		),
	},
	{
		group: "Statements",
		section: "mis",
		to: "/mis/ratios",
		label: "Ratios",
		icon: ICON(
			<>
				<path d="M3 13L13 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
				<circle cx="4.5" cy="4.5" r="2" stroke="currentColor" strokeWidth="1.4" />
				<circle cx="11.5" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.4" />
			</>,
		),
	},
	{
		group: "Statements",
		section: "mis",
		to: "/mis/controls",
		label: "Controls",
		badge: "controls",
		icon: ICON(
			<>
				<path d="M8 1.5l5.5 2v4c0 3.3-2.3 5.7-5.5 7-3.2-1.3-5.5-3.7-5.5-7v-4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
				<path d="M5.5 8l1.8 1.8L10.8 6.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
			</>,
		),
	},
	{
		group: "Statements",
		section: "mis",
		to: "/mis/alerts",
		label: "Alerts",
		badge: "alerts",
		icon: ICON(
			<>
				<path d="M8 2l6.5 11.5h-13z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
				<path d="M8 6.5v3M8 11.6v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
			</>,
		),
	},
	{
		group: "Finance",
		section: "wc",
		to: "/wc",
		label: "Working Capital",
		icon: ICON(
			<>
				<circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
				<path
					d="M8 5v3l2 2"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
				/>
			</>,
		),
	},
];

interface SidebarProps {
	/** Resolved company name (shown as the brand). */
	company?: string;
	/** Company sent to the API ("" = server default). */
	selectedCompany: string;
	onCompanyChange: (company: string) => void;
	period: PeriodSelection;
	sections: DashboardSections;
	/** Drawer state below lg (always shown from lg up). */
	open?: boolean;
	onClose?: () => void;
	/** MIS refresh counter (re-keys the controls / alerts badges). */
	refreshKey?: number;
}

export function Sidebar({
	company,
	selectedCompany,
	onCompanyChange,
	period,
	sections,
	open = false,
	onClose,
	refreshKey = 0,
}: SidebarProps) {
	// Links keep the current period / tax / company (A1).
	const { stateSearch } = useDashState();
	const brand = company?.trim() || "Biz Dashboard";
	const { data: companiesData } = useCompanies();
	const companies = companiesData?.message ?? [];
	const visible = ITEMS.filter((it) => sections[it.section]);
	// Controls / alerts badges: fetched lazily, server-cached, shared with their pages.
	const { summary, counts } = useStatementBadges(refreshKey, sections.mis);
	const groups = visible.reduce<Record<string, NavItem[]>>((acc, it) => {
		(acc[it.group] ??= []).push(it);
		return acc;
	}, {});
	return (
		<>
		{open && (
			<div
				className="lg:hidden fixed inset-0 z-[49] bg-[rgba(26,24,16,.45)]"
				onClick={onClose}
				aria-hidden="true"
			/>
		)}
		<nav
			className={cn(
				"fixed top-0 left-0 bottom-0 w-[232px] bg-sidebar-bg flex flex-col px-4 py-6 z-50 overflow-y-auto border-r border-black/20",
				"transition-transform duration-200 lg:translate-x-0",
				open ? "translate-x-0" : "-translate-x-full",
			)}
			style={{ color: "var(--sidebar-text)" }}
			aria-label="Dashboard navigation"
		>
			<div
				className="font-serif text-[22px] leading-tight mb-1 break-words"
				style={{ color: "var(--sidebar-text-active)" }}
				title={brand}
			>
				{brand}
			</div>
			<div
				className="text-[10px] tracking-[0.14em] uppercase mb-7 font-medium"
				style={{ color: "var(--sidebar-text-muted)" }}
			>
				Biz Dashboard
			</div>

			{companies.length > 1 && (
				<label className="block -mt-4 mb-5">
					<span className="sr-only">Company</span>
					<select
						value={selectedCompany || company || ""}
						onChange={(e) => onCompanyChange(e.target.value)}
						className="w-full px-2 py-1.5 text-[12px] rounded-md bg-transparent border"
						style={{
							color: "var(--sidebar-text)",
							borderColor: "var(--sidebar-divider)",
						}}
						aria-label="Company"
					>
						{companies.map((c) => (
							<option key={c} value={c} style={{ color: "#1a1810" }}>
								{c}
							</option>
						))}
					</select>
				</label>
			)}

			{sections.mis && summary && (
				<div className={companies.length > 1 ? "-mt-2 mb-1" : "-mt-4 mb-1"}>
					<ControlsBadge summary={summary} variant="dark" />
				</div>
			)}

			{Object.entries(groups).map(([group, items]) => (
				<div key={group}>
					<div
						className="text-[9px] font-semibold tracking-[0.14em] uppercase px-2 mt-5 mb-1.5"
						style={{ color: "var(--sidebar-text-muted)" }}
					>
						{group}
					</div>
					{items.map((it) => (
						<NavLink
							key={it.to}
							to={{ pathname: it.to, search: stateSearch }}
							end={it.to === "/mis"}
							className={({ isActive }) =>
								cn(
									"sidebar-link flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-[13px] mb-[1px] transition-colors",
									it.disabled
										? "sidebar-link--disabled cursor-not-allowed"
										: "cursor-pointer",
									isActive && !it.disabled && "sidebar-link--active font-medium",
								)
							}
							onClick={(e) => {
								if (it.disabled) e.preventDefault();
							}}
						>
							{it.icon}
							{it.label}
							{it.badge === "controls" && summary && (summary.warn > 0 || summary.fail > 0) && (
								<span
									className={cn(
										"ml-auto min-w-[20px] px-1.5 rounded-full text-[10px] font-bold text-center tabular-nums",
										summary.fail ? "bg-[#c44] text-white" : "bg-[#e0a33a] text-[#1a1810]",
									)}
									aria-label={controlsText(summary)}
									title={controlsText(summary)}
								>
									{summary.fail || summary.warn}
								</span>
							)}
							{it.badge === "alerts" && counts && counts.high > 0 && (
								<span
									className="ml-auto min-w-[20px] px-1.5 rounded-full text-[10px] font-bold text-center tabular-nums bg-[#c44] text-white"
									aria-label={`${counts.high} high-severity alerts`}
									title={`${counts.high} high-severity alerts`}
								>
									{counts.high}
								</span>
							)}
							{it.disabled && (
								<span
									className="ml-auto text-[8px] tracking-wider uppercase font-medium"
									style={{ color: "var(--sidebar-text-muted)" }}
								>
									soon
								</span>
							)}
						</NavLink>
					))}
				</div>
			))}

			<div
				className="mt-auto pt-4"
				style={{ borderTop: "1px solid var(--sidebar-divider)" }}
			>
				<div
					className="text-[10px] leading-[1.7]"
					style={{ color: "var(--sidebar-text-muted)" }}
				>
					{describePeriod(period)}
					<br />
					Company Dashboard · Frappe
				</div>
			</div>
		</nav>
		</>
	);
}
