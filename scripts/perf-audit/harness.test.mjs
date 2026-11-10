const PATTERN_ROW_IDENTITY = /row identity/;
const PATTERN_INTERRUPTED = /interrupted/;
const PATTERN_MISSING = /missing/;
const PATTERN_COLUMNS = /columns/;
const PATTERN_SCROLL = /scroll/;
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium } from "@playwright/test";

import { initialJsBytes } from "./build-graph.mjs";
import { publishSeed } from "./cache.mjs";
import { captureGeometry, assertVisibleState } from "./visible-state.mjs";

test("initial graph counts shared imports once and excludes unrelated lazy chunks", () => {
	const graph = {
		a: { gzipBytes: 10, imports: ["shared"] },
		b: { gzipBytes: 20, imports: ["shared"] },
		shared: { gzipBytes: 5, imports: [] },
		lazy: { gzipBytes: 100, imports: [] },
	};
	assert.equal(initialJsBytes(graph, ["a", "b"]), 35);
	assert.throws(() => initialJsBytes(graph, ["missing"]), PATTERN_MISSING);
});
test("a failed seed cannot become visible and concurrent publishers return a complete seed", async () => {
	const directory = mkdtempSync(join(tmpdir(), "audit-cache-test-"));
	try {
		await assert.rejects(
			publishSeed(directory, "seed", async () => {
				throw new Error("interrupted");
			}),
			PATTERN_INTERRUPTED,
		);
		const builds = [0, 1].map(() =>
			publishSeed(directory, "seed", async (path) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				mkdirSync(join(path, "uploads"));
				writeFileSync(join(path, "data.db"), "complete");
			}),
		);
		const paths = await Promise.all(builds);
		for (const path of paths) assert.equal(readFileSync(join(path, "data.db"), "utf8"), "complete");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
test("geometry rejects 31px columns, different rows and changed scroll; unchanged state passes", async () => {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage();
		await page.setContent(
			'<main style="height:100px;overflow:auto"><table style="table-layout:fixed;width:400px"><thead><tr><th style="width:100px">Title</th><th>Status</th></tr></thead><tbody><tr><td>Post 1</td><td>Draft</td></tr></tbody></table><div style="height:2000px"></div></main>',
		);
		const before = await captureGeometry(page);
		assertVisibleState(before, await captureGeometry(page));
		await page
			.locator("th")
			.first()
			.evaluate((element) => (element.style.width = "131px"));
		var changed = await captureGeometry(page);
		assert.throws(() => assertVisibleState(before, changed), PATTERN_COLUMNS);
		await page
			.locator("th")
			.first()
			.evaluate((element) => (element.style.width = "100px"));
		await page
			.locator("tbody td")
			.first()
			.evaluate((element) => (element.textContent = "Post 2"));
		changed = await captureGeometry(page);
		assert.throws(() => assertVisibleState(before, changed), PATTERN_ROW_IDENTITY);
		await page
			.locator("tbody td")
			.first()
			.evaluate((element) => (element.textContent = "Post 1"));
		await page.locator("main").evaluate((element) => (element.scrollTop = 100));
		changed = await captureGeometry(page);
		assert.throws(() => assertVisibleState(before, changed), PATTERN_SCROLL);
	} finally {
		await browser.close();
	}
});

test("collector exports departed documents on navigation", async () => {
	const { createServer } = await import("node:http");
	const server = createServer((_request, response) => response.end("<p>document</p>"));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const browser = await chromium.launch();
	try {
		const snapshots = [];
		const context = await browser.newContext();
		await context.exposeBinding("__auditDocument", (_source, snapshot) => snapshots.push(snapshot));
		await context.addInitScript(readFileSync(new URL("./collector.js", import.meta.url), "utf8"));
		const page = await context.newPage();
		const url = `http://127.0.0.1:${server.address().port}`;
		await page.goto(url + "/first");
		await page.goto(url + "/second");
		await page.waitForFunction(() => Boolean(window.__perfAudit));
		assert.equal(
			snapshots.some((snapshot) => snapshot.finalPath === "/first"),
			true,
		);
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("per-key script samples detect an expensive input handler", async () => {
	const { createServer } = await import("node:http");
	const { runMeasurement } = await import("./measure.mjs");
	const server = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end('<input aria-label="Text">');
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const browser = await chromium.launch();
	try {
		const site = { baseUrl: `http://127.0.0.1:${server.address().port}`, takeQueries: () => [] };
		const target = {
			id: "scenario:expensive-input",
			kind: "scenario",
			async run({ page, step, typeKeys }) {
				await step("load", () => page.goto(site.baseUrl));
				await page.locator("input").evaluate((element) =>
					element.addEventListener("keydown", () => {
						const deadline = performance.now() + 60;
						while (performance.now() < deadline) {
							/* Deliberately block an input handler. */
						}
					}),
				);
				await step("type", () => typeKeys(page.locator("input"), "a"));
				await step("dialog transition", async () => {
					await page.evaluate(() => {
						const dialog = document.createElement("div");
						dialog.setAttribute("role", "dialog");
						dialog.textContent = "Transient dialog";
						document.body.append(dialog);
					});
					await page.waitForTimeout(500);
					await page.locator('[role="dialog"]').evaluate((element) => element.remove());
				});
			},
		};
		const result = await runMeasurement({
			browser,
			site,
			target,
			viewportName: "desktop",
			pass: 0,
			outDir: tmpdir(),
			options: { cpu: 1, slowApi: 0, midpointMs: 20 },
		});
		assert.equal(result.status, "ok", result.error);
		assert.ok(result.scriptSamples.find((sample) => sample.key === "a").scriptMs >= 50);
		assert.equal(
			result.transitionSamples.find((sample) => sample.step === "dialog transition").dialogs.length,
			1,
		);
	} finally {
		await browser.close();
		await new Promise((resolve) => server.close(resolve));
	}
});
