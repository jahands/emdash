import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { groupPublishedDateBuckets } from "../../../src/widgets/archives.js";

const buckets = [
	{ bucket: "2026-07-15", count: 3 },
	{ bucket: "2026-01-20", count: 1 },
	{ bucket: "2026-01-01T00:30:00Z", count: 1 },
	{ bucket: "2025-12-15", count: 4 },
];

const originalTimeZone = process.env.TZ;

describe("groupPublishedDateBuckets", () => {
	beforeEach(() => {
		process.env.TZ = "UTC";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = originalTimeZone;
	});

	it("labels and links each month in order, summing its buckets", () => {
		expect(groupPublishedDateBuckets(buckets)).toEqual([
			{ label: "July 2026", count: 3, url: "/archives/2026/07" },
			{ label: "January 2026", count: 2, url: "/archives/2026/01" },
			{ label: "December 2025", count: 4, url: "/archives/2025/12" },
		]);
	});

	it("groups by the server's local time zone", () => {
		process.env.TZ = "America/New_York";
		expect(groupPublishedDateBuckets(buckets)).toEqual([
			{ label: "July 2026", count: 3, url: "/archives/2026/07" },
			{ label: "January 2026", count: 1, url: "/archives/2026/01" },
			{ label: "December 2025", count: 5, url: "/archives/2025/12" },
		]);
		expect(groupPublishedDateBuckets(buckets, { type: "yearly" })).toEqual([
			{ label: "2026", count: 4, url: "/archives/2026" },
			{ label: "2025", count: 5, url: "/archives/2025" },
		]);
	});

	it("sums buckets into years when type is yearly", () => {
		expect(groupPublishedDateBuckets(buckets, { type: "yearly" })).toEqual([
			{ label: "2026", count: 5, url: "/archives/2026" },
			{ label: "2025", count: 4, url: "/archives/2025" },
		]);
	});

	it("keeps the newest groups up to the limit", () => {
		expect(groupPublishedDateBuckets(buckets, { limit: 2 }).map((group) => group.url)).toEqual([
			"/archives/2026/07",
			"/archives/2026/01",
		]);
		expect(groupPublishedDateBuckets(buckets, { type: "yearly", limit: 1 })).toEqual([
			{ label: "2026", count: 5, url: "/archives/2026" },
		]);
	});

	it("skips buckets that aren't dates", () => {
		expect(
			groupPublishedDateBuckets([
				{ bucket: "", count: 1 },
				{ bucket: "not-a-date", count: 2 },
				{ bucket: "2026-05-01T12:00:00Z", count: 1 },
			]),
		).toEqual([{ label: "May 2026", count: 1, url: "/archives/2026/05" }]);
	});

	it("formats only the displayed months", () => {
		const format = vi.spyOn(Date.prototype, "toLocaleDateString");
		groupPublishedDateBuckets(buckets, { limit: 1 });
		expect(format).toHaveBeenCalledTimes(1);
		format.mockClear();
		expect(groupPublishedDateBuckets(buckets, { limit: 0 })).toEqual([]);
		expect(format).not.toHaveBeenCalled();
	});
});
