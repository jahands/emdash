import { afterEach, describe, expect, it, vi } from "vitest";

import { groupPublishedMonths } from "../../../src/widgets/archives.js";

const months = [
	{ month: "2026-07", count: 3 },
	{ month: "2026-01", count: 2 },
	{ month: "2025-12", count: 4 },
];

describe("groupPublishedMonths", () => {
	afterEach(() => vi.restoreAllMocks());

	it("labels and links each month in order", () => {
		expect(groupPublishedMonths(months)).toEqual([
			{ label: "July 2026", count: 3, url: "/archives/2026/07" },
			{ label: "January 2026", count: 2, url: "/archives/2026/01" },
			{ label: "December 2025", count: 4, url: "/archives/2025/12" },
		]);
	});

	it("labels a month by UTC, whatever the server timezone", () => {
		const format = vi.spyOn(Date.prototype, "toLocaleDateString");
		expect(groupPublishedMonths([{ month: "2026-03", count: 1 }])[0]?.label).toBe("March 2026");
		expect(format).toHaveBeenCalledWith("en-US", expect.objectContaining({ timeZone: "UTC" }));
	});

	it("sums months into years when type is yearly", () => {
		expect(groupPublishedMonths(months, { type: "yearly" })).toEqual([
			{ label: "2026", count: 5, url: "/archives/2026" },
			{ label: "2025", count: 4, url: "/archives/2025" },
		]);
	});

	it("keeps the newest groups up to the limit", () => {
		expect(groupPublishedMonths(months, { limit: 2 }).map((group) => group.url)).toEqual([
			"/archives/2026/07",
			"/archives/2026/01",
		]);
		expect(groupPublishedMonths(months, { type: "yearly", limit: 1 })).toEqual([
			{ label: "2026", count: 5, url: "/archives/2026" },
		]);
	});

	it("formats only the displayed months", () => {
		const format = vi.spyOn(Date.prototype, "toLocaleDateString");
		groupPublishedMonths(months, { limit: 1 });
		expect(format).toHaveBeenCalledTimes(1);
		format.mockClear();
		expect(groupPublishedMonths(months, { limit: 0 })).toEqual([]);
		expect(format).not.toHaveBeenCalled();
	});
});
