import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

interface NavItem {
	to: string;
	label: string;
	icon: React.ReactNode;
	group: string;
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
		to: "/",
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
		to: "/pnl",
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
		to: "/assortment",
		label: "SKU Assortment",
		disabled: true,
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
		to: "/sku",
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
		to: "/channel",
		label: "SS & Distributors",
		disabled: true,
		icon: ICON(
			<>
				<rect x="1" y="9" width="3" height="6" rx="1" fill="currentColor" />
				<rect x="6" y="5" width="3" height="10" rx="1" fill="currentColor" />
				<rect x="11" y="2" width="3" height="13" rx="1" fill="currentColor" />
			</>,
		),
	},
	{
		group: "Channel & Market",
		to: "/tam",
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
		to: "/wc",
		label: "Working Capital",
		disabled: true,
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

export function Sidebar({ company, period }: { company?: string; period?: string }) {
	const brand = company?.trim() || "Company MIS";
	const groups = ITEMS.reduce<Record<string, NavItem[]>>((acc, it) => {
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
				Consumer MIS
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
							end={it.to === "/"}
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
