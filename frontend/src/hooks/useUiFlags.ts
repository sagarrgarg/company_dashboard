import { useMemo } from "react";
import { useFrappeGetCall } from "frappe-react-sdk";
import {
	bootComingSoon,
	bootSections,
	EMPTY_COMING_SOON,
	type ComingSoonTiles,
	type DashboardSections,
} from "@/lib/boot";
import type { UiFlags } from "@/types/mis";

/** The one source of "Coming soon" flags + section access. Fetched fresh from
 *  get_ui_flags (so a settings change applies on the next load, not when the boot cache
 *  clears); falls back to the boot payload while loading or on error. Every component
 *  calls this hook — SWR de-duplicates the request. */
export function useUiFlags(): { comingSoon: ComingSoonTiles; sections: DashboardSections } {
	const { data } = useFrappeGetCall<{ message: UiFlags }>(
		"company_dashboard.api.mis.get_ui_flags",
		{},
		"mis.ui_flags",
		{ revalidateOnFocus: false, dedupingInterval: 60_000 },
	);
	const fresh = data?.message;
	return useMemo(() => {
		if (!fresh) return { comingSoon: bootComingSoon(), sections: bootSections() };
		return {
			comingSoon: { ...EMPTY_COMING_SOON, ...(fresh.coming_soon_tiles as Partial<ComingSoonTiles>) },
			sections: fresh.sections ?? bootSections(),
		};
	}, [fresh]);
}

export function useComingSoon(): ComingSoonTiles {
	return useUiFlags().comingSoon;
}
