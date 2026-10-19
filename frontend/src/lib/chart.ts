/** Month-to-date handling for line charts (F16): each series `k` is split into
 *  `k__solid` (complete months only) and `k__mtd` (partial months plus their neighbour,
 *  drawn dashed), so a half-finished month never looks like a real drop. */
export function splitPartial<T extends object>(
	rows: T[],
	keys: string[],
	isPartial: (row: T, index: number) => boolean,
): Array<T & Record<string, number | null>> {
	const flags = rows.map(isPartial);
	return rows.map((r, i) => {
		const out = { ...r } as T & Record<string, number | null>;
		const touches = flags[i] || Boolean(flags[i - 1]) || Boolean(flags[i + 1]);
		for (const k of keys) {
			const v = (r as Record<string, unknown>)[k];
			const num = typeof v === "number" && Number.isFinite(v) ? v : null;
			(out as Record<string, number | null>)[`${k}__solid`] = flags[i] ? null : num;
			(out as Record<string, number | null>)[`${k}__mtd`] = touches ? num : null;
		}
		return out;
	});
}

export const TOOLTIP_STYLE = {
	background: "#ffffff",
	border: "1px solid rgba(40,30,15,.18)",
	borderRadius: 10,
	fontSize: 12,
	padding: "8px 12px",
	boxShadow: "0 4px 16px rgba(40,30,15,.08)",
} as const;
