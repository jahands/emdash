import assert from "node:assert/strict";
import test from "node:test";

import { loadSharp } from "../lib/deps.mjs";
import { decodedSize } from "../lib/image-pixels.mjs";
import {
	auditImages,
	computeCls,
	computeTbt,
	imageStates,
	isCompressibleMime,
	oversizeFactor,
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

const loadedImage = (src, natural, rendered, extra = {}) => ({
	src,
	complete: true,
	visible: true,
	naturalWidth: natural[0],
	naturalHeight: natural[1],
	renderedWidth: rendered[0],
	renderedHeight: rendered[1],
	...extra,
});

void test("oversized images need both a 2x pixel excess and 50 KiB", () => {
	const images = [
		loadedImage("a", [4000, 3000], [176, 99]),
		loadedImage("b", [400, 300], [200, 150]),
		loadedImage("c", [4000, 3000], [176, 99]),
		loadedImage("d", [900, 600], [200, 150]),
	];
	const bytes = { a: 3_000_000, b: 80_000, c: 20_000, d: 200_000 };
	const result = auditImages(images, 2, { bytesForUrl: (src) => bytes[src] });
	assert.deepEqual(
		result.map((r) => r.oversized),
		[true, false, false, true],
	);
	assert.equal(result[0].needed, "352x198");
	assert.equal(result[3].factor, 2.3);
});

void test("oversize is judged on the decoded pixels, not the density-corrected naturalWidth", () => {
	// A 2560px file chosen from a srcset for an 1136px slot reports naturalWidth 1136.
	const hero = loadedImage("hero", [1136, 852], [568, 284], { srcset: "a 1136w, b 2560w" });
	const decoded = { width: 2560, height: 1920, from: "decoded" };
	const [withPixels] = auditImages([hero], 2, {
		bytesForUrl: () => 400_000,
		pixelsForUrl: () => decoded,
	});
	assert.equal(withPixels.pixels, "2560x1920");
	assert.equal(withPixels.pixelsFrom, "decoded");
	assert.equal(withPixels.natural, "1136x852");
	assert.equal(withPixels.oversized, true);
	const [fallback] = auditImages([hero], 2, { bytesForUrl: () => 400_000 });
	assert.equal(fallback.pixelsFrom, "naturalWidth");
	assert.equal(fallback.oversized, false);
});

void test("object-fit cover only counts the side that is not cropped", () => {
	const box = { renderedWidth: 300, renderedHeight: 300 };
	const pixels = { width: 1200, height: 600 };
	assert.equal(oversizeFactor(pixels, { ...box, objectFit: "cover" }, 1).factor, 2);
	assert.equal(oversizeFactor(pixels, { ...box, objectFit: "fill" }, 1).factor, 4);
});

void test("offscreen, failed and pending images are kept apart from painted ones", () => {
	const images = [
		loadedImage("painted", [4000, 3000], [176, 99]),
		loadedImage("below", [4000, 3000], [176, 99], { visible: false }),
		{ ...loadedImage("broken", [0, 0], [100, 100]), complete: true },
		{ ...loadedImage("lazy", [0, 0], [100, 100], { loading: "lazy" }), complete: false },
		loadedImage("404", [0, 0], [100, 100]),
	];
	const result = auditImages(images, 2, {
		bytesForUrl: () => 3_000_000,
		requestFailed: (src) => src === "404",
	});
	assert.deepEqual(
		result.map((r) => r.state),
		["painted", "offscreen", "failed", "not-loaded", "failed"],
	);
	assert.deepEqual(
		result.map((r) => r.oversized),
		[true, false, false, false, false],
	);
	assert.equal(result[1].factor, 15.2, "offscreen images still report their excess");
	assert.deepEqual(imageStates(result), { painted: 1, offscreen: 1, failed: 2, "not-loaded": 1 });
});

void test("decoded sizes follow EXIF orientation", async () => {
	const sharp = loadSharp();
	const rotated = await sharp({
		create: { width: 300, height: 200, channels: 3, background: "#777" },
	})
		.jpeg()
		.withMetadata({ orientation: 6 })
		.toBuffer();
	assert.deepEqual(await decodedSize(rotated), { width: 200, height: 300 });
	const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
	assert.equal(await decodedSize(svg), null);
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
	assert.deepEqual(summary.criticalChain, [
		{ url: doc, via: null },
		{ url: js, via: "initiator" },
		{ url: me, via: "initiator" },
		{ url: list, via: "inferred-timing" },
	]);
	assert.equal(summary.inferredLinks, 1);
	assert.equal(summary.maxDepth, 4);
	assert.equal(summary.bytesByType.Fetch, 1200);
});

void test("a request Chromium names as the initiator beats a timing guess", () => {
	const js = "http://x/_astro/app.js";
	const first = "http://x/_emdash/api/a";
	const preflight = "http://x/_emdash/api/b";
	const summary = summarizeRequests([
		{ url: js, type: "Script", start: 0, end: 100, initiatorUrl: null },
		{ url: first, type: "Fetch", start: 110, end: 150, initiatorUrl: js, initiatorType: "script" },
		{
			url: preflight,
			type: "Fetch",
			start: 160,
			end: 200,
			initiatorUrl: js,
			initiatorType: "script",
			initiatorRequestUrl: js,
		},
	]);
	const row = summary.waterfall.find((r) => r.url === preflight);
	assert.equal(row.waitedOn, js);
	assert.equal(row.waitedOnSource, "initiator-request");
	assert.deepEqual(row.initiator, { type: "script", url: js });
	assert.equal(summary.waterfall.find((r) => r.url === first).waitedOnSource, "initiator");
});

void test("Server-Timing values parse by name", () => {
	assert.deepEqual(parseServerTiming('db.count;dur=12;desc="Query count", rt.init;dur=3'), {
		"db.count": 12,
		"rt.init": 3,
	});
});

void test("compressed transfer counts uncompressed text at its compressed size", () => {
	const summary = summarizeRequests([
		{ url: "http://x/", type: "Document", start: 0, end: 10, bytes: 5000, compressedBytes: 1200 },
		{ url: "http://x/a.js", type: "Script", start: 10, end: 20, bytes: 800, encoding: "br" },
		{ url: "http://x/p.png", type: "Image", start: 10, end: 30, bytes: 9000 },
	]);
	assert.equal(summary.totalBytes, 14_800);
	assert.equal(summary.compressedBytes, 11_000);
});

void test("only text types count as compressible", () => {
	assert.equal(isCompressibleMime("text/html; charset=utf-8"), true);
	assert.equal(isCompressibleMime("application/json"), true);
	assert.equal(isCompressibleMime("image/svg+xml"), true);
	assert.equal(isCompressibleMime("text/event-stream"), false);
	assert.equal(isCompressibleMime("image/png"), false);
	assert.equal(isCompressibleMime("font/woff2"), false);
	assert.equal(isCompressibleMime(undefined), false);
});
