export type ArchiveGroupType = "monthly" | "yearly";

export interface ArchiveGroup {
	label: string;
	count: number;
	url: string;
}

/**
 * Group published entry counts per UTC month (`YYYY-MM`, newest first) for
 * the Archives widget.
 */
export function groupPublishedMonths(
	months: ReadonlyArray<{ month: string; count: number }>,
	options: { type?: ArchiveGroupType; limit?: number } = {},
): ArchiveGroup[] {
	const type = options.type ?? "monthly";
	const limit = options.limit ?? 12;
	const archives = new Map<string, { year: string; month: string; count: number }>();

	for (const { month: key, count } of months) {
		const year = key.slice(0, 4);
		const month = key.slice(5, 7);
		const groupKey = type === "yearly" ? year : key;
		const existing = archives.get(groupKey);
		if (existing) {
			existing.count += count;
		} else {
			archives.set(groupKey, { year, month, count });
		}
	}

	return [...archives.values()].slice(0, limit).map(({ year, month, count }) =>
		type === "yearly"
			? { label: year, count, url: `/archives/${year}` }
			: {
					label: new Date(Date.UTC(Number(year), Number(month) - 1, 1)).toLocaleDateString(
						"en-US",
						{ year: "numeric", month: "long", timeZone: "UTC" },
					),
					count,
					url: `/archives/${year}/${month}`,
				},
	);
}
