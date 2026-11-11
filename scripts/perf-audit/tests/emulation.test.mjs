import assert from "node:assert/strict";
import test from "node:test";

import { loadSharp } from "../lib/deps.mjs";
import { chooseFormat, parseResizeUrl, resizeImage } from "../lib/resize-emulation.mjs";

const origin = "http://localhost:14612";

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
	const parsed = parseResizeUrl("/cdn-cgi/image/w=400,q=70,f=auto/_astro/hero.png", origin);
	assert.deepEqual(parsed.options, { width: 400, quality: 70, format: "auto" });
	assert.equal(parsed.source, `${origin}/_astro/hero.png`);
	assert.equal(parseResizeUrl("/_image?w=400", origin), null);
});

void test("format auto follows the Accept header", () => {
	assert.equal(chooseFormat("auto", "image/avif,image/webp,*/*"), "avif");
	assert.equal(chooseFormat("auto", "image/webp,*/*"), "webp");
	assert.equal(chooseFormat(undefined, "", "image/png"), "png");
	assert.equal(chooseFormat("jpeg", "image/avif"), "jpeg");
});

void test("resizes to the requested width and never enlarges with scale-down", async () => {
	const sharp = loadSharp();
	const source = await sharp({
		create: { width: 1600, height: 1000, channels: 3, background: "#888" },
	})
		.jpeg()
		.toBuffer();
	const small = await resizeImage(source, { width: 400, format: "webp" }, "", "image/jpeg");
	assert.equal(small.contentType, "image/webp");
	assert.equal((await sharp(small.body).metadata()).width, 400);
	const big = await resizeImage(source, { width: 3000, fit: "scale-down" }, "", "image/jpeg");
	assert.equal((await sharp(big.body).metadata()).width, 1600);
	const dpr = await resizeImage(source, { width: 300, dpr: 2 }, "", "image/jpeg");
	assert.equal((await sharp(dpr.body).metadata()).width, 600);
});
