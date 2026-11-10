import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { openFromSidebar } from "./navigation.mjs";

const PATTERN_STILL_OPEN = /After tapping "Posts" in the phone menu, the menu is still open/;
const PATTERN_COVERED = /After tapping "Posts" in the phone menu, main is covered by div.overlay/;

/**
 * A phone shell with the admin's script policy whose menu, after a link tap,
 * slides closed, stays open, or leaves its overlay behind.
 */
const shell = (mode) => `<!doctype html>
<meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'">
<style>
	body { margin: 0; }
	header { height: 56px; }
	.emdash-sidebar { position: fixed; inset-block: 0; inset-inline-start: 0; width: 260px; background: #eee; z-index: 50; transform: translateX(-100%); transition: transform 400ms; }
	.emdash-sidebar[data-state="expanded"] { transform: none; }
	.overlay { position: fixed; inset: 0; z-index: 40; pointer-events: none; }
	.overlay.open { pointer-events: auto; }
	main { min-height: 600px; }
</style>
<header><button data-sidebar="trigger">Menu</button></header>
<div class="overlay"></div>
<div class="emdash-sidebar" data-mobile="true" data-state="collapsed"><a href="/posts">Posts</a></div>
<main><h1>Dashboard</h1></main>
<script>
	const sheet = document.querySelector(".emdash-sidebar");
	const overlay = document.querySelector(".overlay");
	const setOpen = (open) => {
		sheet.dataset.state = open ? "expanded" : "collapsed";
		overlay.classList.toggle("open", open);
	};
	document.querySelector("[data-sidebar=trigger]").addEventListener("click", () => setOpen(true));
	sheet.querySelector("a").addEventListener("click", (event) => {
		event.preventDefault();
		history.pushState(null, "", "/posts");
		document.querySelector("h1").textContent = "Posts";
		if ("${mode}" === "closes") setOpen(false);
		if ("${mode}" === "overlay") sheet.dataset.state = "collapsed";
	});
</script>`;

test("phone navigation passes when the menu closes and fails while it or its overlay stays", async () => {
	let mode = "closes";
	const server = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(shell(mode));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			isMobile: true,
			hasTouch: true,
		});
		const page = await context.newPage();
		const url = `http://127.0.0.1:${server.address().port}/`;
		const posts = page.locator(".emdash-sidebar a");

		await page.goto(url);
		await openFromSidebar(page, "mobile", posts, { timeout: 3000 });
		assert.equal(new URL(page.url()).pathname, "/posts");

		for (const [failingMode, pattern] of [
			["stays", PATTERN_STILL_OPEN],
			["overlay", PATTERN_COVERED],
		]) {
			mode = failingMode;
			await page.goto(url);
			await assert.rejects(openFromSidebar(page, "mobile", posts, { timeout: 3000 }), pattern);
		}
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
});
