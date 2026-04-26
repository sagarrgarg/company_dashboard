import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { DashboardSections } from "@/App";

interface NavItem {
	to: string;
	label: string;
	icon: React.ReactNode;
	group: string;
	section: "mis" | "wc";
	disabled?: boolean;
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
	company?: string;
	period?: string;
	sections: DashboardSections;
}

export function Sidebar({ company, period, sections }: SidebarProps) {
	const brand = company?.trim() || "Biz Dashboard";
	const visible = ITEMS.filter((it) => sections[it.section]);
	const groups = visible.reduce<Record<string, NavItem[]>>((acc, it) => {
		(acc[it.group] ??= []).push(it);
		return acc;
	}, {});
	return (
		<nav className="fixed top-0 left-0 bottom-0 w-[232px] bg-sidebar-bg flex flex-col px-4 py-6 z-50 overflow-y-auto border-r border-black/20">
			<div
				className="font-serif text-white text-[22px] leading-tight mb-1 break-words"
				title={brand}
			>
				{brand}
			</div>
			<div className="text-[10px] tracking-[0.14em] uppercase text-white/55 mb-7 font-medium">
				Biz Dashboard
			</div>

			{Object.entries(groups).map(([group, items]) => (
				<div key={group}>
					<div className="text-[9px] font-semibold text-white/50 tracking-[0.14em] uppercase px-2 mt-5 mb-1.5">
						{group}
					</div>
					{items.map((it) => (
						<NavLink
							key={it.to}
							to={it.to}
							end={it.to === "/mis"}
							className={({ isActive }) =>
								cn(
									"flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-[13px] mb-[1px] transition-colors",
									it.disabled
										? "text-white/40 cursor-not-allowed"
										: "text-white/82 hover:bg-white/10 hover:text-white cursor-pointer",
									isActive &&
										!it.disabled &&
										"bg-white/[.16] text-white font-medium shadow-[inset_2px_0_0_rgba(234,243,230,0.9)]",
								)
							}
							onClick={(e) => {
								if (it.disabled) e.preventDefault();
							}}
						>
							{it.icon}
							{it.label}
							{it.disabled && (
								<span className="ml-auto text-[8px] tracking-wider uppercase text-white/40 font-medium">
									soon
								</span>
							)}
						</NavLink>
					))}
				</div>
			))}

			<div className="mt-auto pt-4 border-t border-white/15">
				<div className="text-[10px] text-white/55 leading-[1.7]">
					{period ?? "Trailing 12 months"}
					<br />
					Company Dashboard · Frappe
				</div>
			</div>
		</nav>
	);
}
