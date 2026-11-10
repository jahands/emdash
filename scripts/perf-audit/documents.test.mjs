import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeDocuments } from "./documents.mjs";
import { computeCls } from "./metrics.mjs";
const doc = (documentId, timeOrigin, value) => ({
	documentId,
	timeOrigin,
	shifts: [{ t: 100, value }],
	timeline: [],
	longTasks: [],
	largestPaints: [],
});

test("earlier documents retain their shifts and time origin", () => {
	const data = mergeDocuments([doc("first", 1000, 0.1), doc("last", 2000, 0.2)]);
	assert.deepEqual(
		data.shifts.map(({ t, value }) => [t, value]),
		[
			[100, 0.1],
			[1100, 0.2],
		],
	);
});

test("CLS windows do not accumulate shifts from different documents", () => {
	const data = mergeDocuments([doc("second", 1500, 0.2), doc("first", 1000, 0.1)]);
	assert.equal(computeCls(data.shifts).cls, 0.2);
});
