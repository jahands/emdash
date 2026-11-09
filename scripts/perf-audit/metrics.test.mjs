import assert from "node:assert/strict";
import { test } from "node:test";

import { computeCls, summarizeDbWait } from "./metrics.mjs";

const shift = (t, value, hadRecentInput = false) => ({ t, value, hadRecentInput });
const query = (startedAtMs, durationMs) => ({ startedAtMs, durationMs });

test("CLS is the largest session window, split by a one-second gap", () => {
	const { cls } = computeCls([shift(0, 0.1), shift(500, 0.1), shift(2000, 0.15)]);
	assert.equal(cls.toFixed(2), "0.20");
});

test("CLS excludes shifts after input while clsAll keeps them", () => {
	const result = computeCls([shift(0, 0.1), shift(100, 0.3, true)]);
	assert.equal(result.cls.toFixed(2), "0.10");
	assert.equal(result.clsAll.toFixed(2), "0.40");
	assert.equal(result.inputShiftCount, 1);
});

test("overlapping queries count as one wave and sequential queries as one each", () => {
	const parallel = summarizeDbWait([
		{ route: "GET /a", events: [query(0, 20), query(1, 20), query(2, 20)] },
	]);
	assert.equal(parallel.waves, 1);
	assert.equal(parallel.dbWallMs, 22);
	const sequential = summarizeDbWait([
		{ route: "GET /a", events: [query(0, 20), query(21, 20), query(42, 20)] },
	]);
	assert.equal(sequential.waves, 3);
	assert.equal(sequential.dbWallMs, 60);
});
