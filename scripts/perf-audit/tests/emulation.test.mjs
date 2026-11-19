import assert from "node:assert/strict";
import test from "node:test";

import { loadSharp } from "../lib/deps.mjs";
import {
	chooseFormat,
	ignoredOptions,
	parseResizeUrl,
	planResize,
	resizeImage,
	responseHeaders,
} from "../lib/resize-emulation.mjs";

const origin = "http://localhost:14612";
const doc = { width: 1080, height: 720 };
const dims = (plan) => `${plan.width}x${plan.height}`;

void test("parses the options and an absolute source whose slashes were collapsed", () => {
	const parsed = parseResizeUrl(
		"/cdn-cgi/image/onerror=redirect,width=1280,height=853,fit=cover,format=webp/http:/localhost:14612/_emdash/api/media/file/a.jpg",
		origin,
	);
	assert.deepEqual(parsed.options, {
		onerror: "redirect",
		width: 1280,
		height: 853,
		fit: "cover",
		format: "webp",
	});
	assert.equal(parsed.source, "http://localhost:14612/_emdash/api/media/file/a.jpg");
});

void test("accepts short option names and relative sources", () => {
	const parsed = parseResizeUrl("/cdn-cgi/image/w=400,q=70,f=auto,g=face/_astro/hero.png", origin);
	assert.deepEqual(parsed.options, { width: 400, quality: 70, format: "auto", gravity: "face" });
	assert.equal(parsed.source, `${origin}/_astro/hero.png`);
	assert.equal(parseResizeUrl("/_image?w=400", origin), null);
	assert.deepEqual(ignoredOptions(parsed.options), ["gravity"]);
});

void test("format auto follows the Accept header", () => {
	assert.equal(chooseFormat("auto", "image/avif,image/webp,*/*"), "avif");
	assert.equal(chooseFormat("auto", "image/webp,*/*"), "webp");
	assert.equal(chooseFormat(undefined, "", "image/png"), "png");
	assert.equal(chooseFormat("jpeg", "image/avif"), "jpeg");
});

// The documented examples, all on a 1080x720 source.
void test("scale-down is the default and never enlarges", () => {
	assert.equal(dims(planResize(doc, { width: 500, height: 500 })), "500x333");
	assert.equal(dims(planResize(doc, { width: 2000, height: 2000, fit: "scale-down" })), "1080x720");
});

void test("contain keeps the aspect ratio and enlarges", () => {
	assert.equal(dims(planResize(doc, { width: 500, height: 500, fit: "contain" })), "500x333");
	assert.equal(dims(planResize(doc, { width: 2000, height: 2000, fit: "contain" })), "2000x1333");
	assert.equal(
		dims(planResize({ width: 100, height: 50 }, { width: 40, height: 40, fit: "contain" })),
		"40x20",
	);
});

void test("cover fills the requested box exactly, enlarging if needed", () => {
	const plan = planResize(doc, { width: 500, height: 500, fit: "cover" });
	assert.equal(dims(plan), "500x500");
	assert.equal(dims(plan.scaled), "750x500");
	assert.equal(dims(planResize(doc, { width: 2000, height: 2000, fit: "cover" })), "2000x2000");
});

void test("crop fills the box but never enlarges", () => {
	assert.equal(dims(planResize(doc, { width: 1296, height: 1296, fit: "crop" })), "1080x720");
	assert.equal(dims(planResize(doc, { width: 500, height: 500, fit: "crop" })), "500x500");
	assert.equal(dims(planResize(doc, { width: 500, height: 1000, fit: "crop" })), "500x720");
});

void test("aspect-crop enforces the ratio without enlarging", () => {
	const plan = planResize(
		{ width: 612, height: 613 },
		{ width: 1920, height: 1120, fit: "aspect-crop" },
	);
	assert.equal(dims(plan), "612x357");
});

void test("pad fills the box with background", () => {
	const plan = planResize(doc, { width: 1080, height: 1080, fit: "pad" });
	assert.equal(dims(plan), "1080x1080");
	assert.equal(dims(plan.scaled), "1080x720");
	assert.equal(plan.pad, true);
});

void test("squeeze distorts to the exact size", () => {
	assert.equal(dims(planResize(doc, { width: 1080, height: 540, fit: "squeeze" })), "1080x540");
	assert.equal(
		dims(planResize({ width: 1080, height: 1080 }, { width: 1080, height: 540, fit: "squeeze" })),
		"1080x540",
	);
});

void test("dpr multiplies the requested size, up to 2", () => {
	assert.equal(planResize({ width: 2000, height: 1000 }, { width: 300, dpr: 2 }).width, 600);
	assert.equal(planResize({ width: 2000, height: 1000 }, { width: 300, dpr: 3 }).width, 600);
});

void test("one dimension scales the other proportionally", () => {
	assert.equal(dims(planResize(doc, { width: 540, fit: "cover" })), "540x360");
	assert.equal(dims(planResize(doc, { height: 360, fit: "pad" })), "540x360");
	assert.equal(dims(planResize(doc, {})), "1080x720");
});

void test("encoded output has the planned pixels and quality 85 by default", async () => {
	const sharp = loadSharp();
	const source = await sharp({
		create: { width: 1600, height: 1000, channels: 3, background: "#888" },
	})
		.jpeg()
		.toBuffer();
	const small = await resizeImage(source, { width: 400, format: "webp" }, "", "image/jpeg");
	assert.equal(small.contentType, "image/webp");
	assert.equal((await sharp(small.body).metadata()).width, 400);
	const contain = await resizeImage(
		source,
		{ width: 40, height: 40, fit: "contain" },
		"",
		"image/jpeg",
	);
	const meta = await sharp(contain.body).metadata();
	assert.equal(`${meta.width}x${meta.height}`, "40x25");
	const pad = await resizeImage(source, { width: 400, height: 400, fit: "pad" }, "", "image/jpeg");
	const padMeta = await sharp(pad.body).metadata();
	assert.equal(`${padMeta.width}x${padMeta.height}`, "400x400");
	const noisy = await sharp({
		create: {
			width: 800,
			height: 500,
			channels: 3,
			noise: { type: "gaussian", mean: 128, sigma: 40 },
		},
	})
		.jpeg({ quality: 95 })
		.toBuffer();
	const byDefault = await resizeImage(noisy, { width: 400 }, "", "image/jpeg");
	const at85 = await resizeImage(noisy, { width: 400, quality: 85 }, "", "image/jpeg");
	const at50 = await resizeImage(noisy, { width: 400, quality: 50 }, "", "image/jpeg");
	assert.equal(byDefault.body.length, at85.body.length);
	assert.notEqual(byDefault.body.length, at50.body.length);
});

void test("responses carry the source's caching headers, not a fixed lifetime", () => {
	const headers = responseHeaders(
		new Headers({
			"cache-control": "public, max-age=0, must-revalidate",
			etag: 'W/"abc"',
			"x-other": "1",
		}),
		"image/webp",
	);
	assert.deepEqual(headers, {
		"x-perf-audit-emulated": "cdn-cgi-image",
		"content-type": "image/webp",
		"cache-control": "public, max-age=0, must-revalidate",
		etag: 'W/"abc"',
	});
});
