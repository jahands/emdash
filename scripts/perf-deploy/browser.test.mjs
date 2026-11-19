import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium } from "@playwright/test";

import { measurePage } from "./browser.mjs";
import { evaluateImages, exitCode, pageProblems, renderSummary } from "./lib.mjs";

const PIXEL = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const PAGES = {
	"/": '<main><h1>Home</h1><img src="/_emdash/api/media/file/a.png" alt="" width="40" height="40"></main>',
	"/plain": "<main><h1>No images</h1></main>",
	"/booting": '<div id="emdash-boot-loader"><div role="status"></div></div>',
};

function listen() {
	const server = createServer((req, res) => {
		if (req.url.startsWith("/_emdash/api/media/file/")) {
			res.setHeader("Content-Type", "image/png");
			res.end(PIXEL);
			return;
		}
		res.setHeader("Content-Type", "text/html");
		const body = PAGES[req.url];
		if (!body) res.statusCode = 500;
		res.end(`<!doctype html><title>t</title>${body ?? "<h1>Internal Server Error</h1>"}`);
	});
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () =>
			resolve({
				origin: `http://127.0.0.1:${server.address().port}`,
				close: () => new Promise((r) => server.close(r)),
			}),
		),
	);
}

void test("measurePage records the document status and rendered content", async (t) => {
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
	} catch (error) {
		t.skip(`Chromium is not installed: ${String(error).split("\n")[0]}`);
		return;
	}
	const server = await listen();
	const outDir = mkdtempSync(join(tmpdir(), "perf-deploy-test-"));
	const measure = async (name, path, expect) => {
		const measured = await measurePage(browser, {
			origin: server.origin,
			name,
			path,
			viewportName: "desktop",
			outDir,
			expect,
		});
		return { ...measured, images: evaluateImages(measured.images).images };
	};
	try {
		const home = await measure("Home", "/", { selector: "main", minMedia: 1 });
		assert.equal(home.status, 200);
		assert.equal(home.images.filter((image) => image.isMedia).length, 1);
		assert.deepEqual(pageProblems(home), []);

		const plain = await measure("Plain", "/plain", { selector: "main", minMedia: 1 });
		assert.deepEqual(pageProblems(plain), ["0 media images, expected at least 1"]);

		const booting = await measure("Admin", "/booting", { selector: "main" });
		assert.deepEqual(pageProblems(booting), [
			"still showing the admin boot loader",
			"no main element",
		]);

		const broken = await measure("Home error", "/error", { selector: "main", minMedia: 1 });
		assert.equal(broken.status, 500);
		assert.equal(broken.images.length, 0);
		const results = {
			run: { runId: "repro500", hostname: "127.0.0.1", imageService: "binding", startedAt: "now" },
			pages: [home, broken],
			coldStarts: [
				{
					moment: "after deploy",
					label: "GET / (logged out)",
					cold: { status: 200 },
					warm: [{ status: 200 }],
				},
			],
			errors: [],
		};
		const summary = renderSummary(results);
		assert.ok(summary.startsWith("# EmDash deploy check: FAIL"));
		assert.ok(summary.includes("- Home error (desktop): document status 500"));
		assert.equal(exitCode(results), 1);
	} finally {
		await browser.close();
		await server.close();
		rmSync(outDir, { recursive: true, force: true });
	}
});
