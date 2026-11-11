import assert from "node:assert/strict";
import test from "node:test";

import {
	auditImages,
	computeCls,
	computeTbt,
	parseServerTiming,
	summarizeRequests,
} from "../lib/metrics.mjs";
import { computeWaves } from "../lib/waves.mjs";

const shift = (startTime, value, hadRecentInput = false) => ({
	startTime,
	value,
	hadRecentInput,
	sources: [
		{
			node: "div",
			previousRect: { x: 0, y: 0, width: 10, height: 10 },
			currentRect: { x: 0, y: 40, width: 10, height: 10 },
		},
	],
});

void test("CLS is the largest session window, not the sum", () => {
	const cls = computeCls([shift(100, 0.05), shift(600, 0.05), shift(3000, 0.08)]);
	assert.equal(Math.round(cls.value * 100) / 100, 0.1);
	assert.equal(cls.windowStart, 100);
	assert.equal(cls.attribution[0].sources[0].moved.dy, 40);
});

void test("a session window closes after 5 seconds even without a gap", () => {
	const shifts = Array.from({ length: 12 }, (_, i) => shift(i * 900, 0.01));
	assert.equal(Math.round(computeCls(shifts).value * 100) / 100, 0.06);
});

void test("shifts right after input do not count", () => {
	assert.equal(computeCls([shift(100, 0.3, true)]).value, 0);
});

void test("TBT counts only the part of long tasks over 50 ms after FCP", () => {
	const tasks = [
		{ startTime: 0, duration: 200 },
		{ startTime: 500, duration: 120 },
		{ startTime: 900, duration: 40 },
	];
	assert.equal(computeTbt(tasks, 100), 50 + 70);
});

void test("oversized images need both a 2x pixel excess and 50 KiB", () => {
	const images = [
		{ src: "a", naturalWidth: 4000, naturalHeight: 3000, renderedWidth: 176, renderedHeight: 99 },
		{ src: "b", naturalWidth: 400, naturalHeight: 300, renderedWidth: 200, renderedHeight: 150 },
		{ src: "c", naturalWidth: 4000, naturalHeight: 3000, renderedWidth: 176, renderedHeight: 99 },
		{ src: "d", naturalWidth: 900, naturalHeight: 600, renderedWidth: 200, renderedHeight: 150 },
	];
	const bytes = { a: 3_000_000, b: 80_000, c: 20_000, d: 200_000 };
	const result = auditImages(images, 2, (src) => bytes[src]);
	assert.deepEqual(
		result.map((r) => r.oversized),
		[true, false, false, true],
	);
	assert.equal(result[0].needed, "352x198");
	assert.equal(result[3].factor, 2.3);
});

void test("waves count requests that waited for an earlier response", () => {
	const parallel = [
		{ start: 0, end: 10 },
		{ start: 1, end: 12 },
	];
	assert.equal(computeWaves(parallel).waves, 1);
	const chain = [
		{ start: 0, end: 10 },
		{ start: 11, end: 20 },
		{ start: 12, end: 18 },
		{ start: 21, end: 30 },
	];
	assert.deepEqual(computeWaves(chain).assignments, [1, 2, 2, 3]);
	assert.equal(computeWaves([]).waves, 0);
});

void test("request summary links API calls to the response they waited for", () => {
	const doc = "http://x/_emdash/admin/";
	const js = "http://x/_astro/app.js";
	const me = "http://x/_emdash/api/auth/me";
	const list = "http://x/_emdash/api/content/posts";
	const summary = summarizeRequests([
		{ url: doc, type: "Document", start: 0, end: 50, bytes: 1000, initiatorUrl: null },
		{ url: js, type: "Script", start: 55, end: 200, bytes: 5000, initiatorUrl: doc },
		{ url: me, type: "Fetch", start: 210, end: 260, bytes: 300, initiatorUrl: js, status: 200 },
		{ url: list, type: "Fetch", start: 270, end: 400, bytes: 900, initiatorUrl: js, status: 500 },
	]);
	assert.equal(summary.api.count, 2);
	assert.equal(summary.api.waves, 2);
	assert.equal(summary.api.lastResponseMs, 400);
	assert.equal(summary.api.failed, 1);
	assert.deepEqual(summary.criticalChain, [doc, js, me, list]);
	assert.equal(summary.maxDepth, 4);
	assert.equal(summary.bytesByType.Fetch, 1200);
});

void test("Server-Timing values parse by name", () => {
	assert.deepEqual(parseServerTiming('db.count;dur=12;desc="Query count", rt.init;dur=3'), {
		"db.count": 12,
		"rt.init": 3,
	});
});
