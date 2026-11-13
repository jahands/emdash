export type ArchiveGroupType = "monthly" | "yearly";

export interface ArchiveGroup {
	label: string;
	count: number;
	url: string;
}

/**
 * Group published entry counts by month or year in the server's local time
 * zone for the Archives widget. Groups keep the order of their first bucket,
 * so buckets ordered newest first give the newest group first.
 *
 * Every entry counted in a bucket falls in the same local month as
 * `new Date(bucket)`; see `getPublishedDateBuckets`.
 */
export function groupPublishedDateBuckets(
	buckets: ReadonlyArray<{ bucket: string; count: number }>,
	options: { type?: ArchiveGroupType; limit?: number } = {},
): ArchiveGroup[] {
	const type = options.type ?? "monthly";
	const limit = options.limit ?? 12;
	const archives = new Map<string, { date: Date; count: number; url: string }>();

	for (const { bucket, count } of buckets) {
		const date = new Date(bucket);
		if (Number.isNaN(date.getTime())) continue;

		const year = date.getFullYear();
		const month = (date.getMonth() + 1).toString().padStart(2, "0");
		const key = type === "yearly" ? `${year}` : `${year}-${month}`;
		const url = type === "yearly" ? `/archives/${year}` : `/archives/${year}/${month}`;

		const existing = archives.get(key);
		if (existing) {
			existing.count += count;
		} else {
			archives.set(key, { date, count, url });
		}
	}

	return [...archives.values()].slice(0, limit).map(({ date, count, url }) => ({
		label:
			type === "yearly"
				? `${date.getFullYear()}`
				: date.toLocaleDateString("en-US", { year: "numeric", month: "long" }),
		count,
		url,
	}));
}
