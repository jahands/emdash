/**
 * Interactions that page loads never reach. Each one samples element
 * geometry while it runs and fails when something visible moved.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { computeCls } from "./metrics.mjs";
import { openContext, recordNetwork, waitForSettle } from "./page-run.mjs";
import { finishGeometry, installProbe, snapshotGeometry } from "./probe.mjs";
import { sleep } from "./proc.mjs";
import { apiClient } from "./seed.mjs";

const ADMIN = "/_emdash/admin";
const EDITOR_SELECTOR = ".ProseMirror";
const SAVE_BUTTONS = [/^save draft$/i, /^save$/i, /publish changes/i, /^update$/i];
const UPLOAD_BUTTON = [/upload/i];
const ERROR_TEXT = /fail|error|could not/i;
const LIST_ERROR_TEXT = /fail|error|could not|try again/i;
const OFFLINE_ERROR_TEXT = /offline|network|fail|error|connection|try again/i;
const ORIGIN_PREFIX = /^https?:\/\/[^/]+/;
const NON_SLUG = /[^a-z0-9]+/gi;

function percentile(values, p) {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

async function openAdmin(browser, { site, cookies, options, viewport, path, phase }) {
	const stats = { resize: { served: 0, failed: 0 } };
	const context = await openContext(browser, { site, viewport, cookies, options, phase, stats });
	await context.addInitScript(installProbe);
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	const network = recordNetwork(cdp);
	if (path) {
		await page.goto(`${site.origin}${path}`, { waitUntil: "load" });
		await waitForSettle(page, network);
	}
	return { context, page, network };
}

/** Run `action` while sampling geometry; report movement and CLS after it. */
async function watch(page, network, action, geometry = {}) {
	await page.evaluate(snapshotGeometry, geometry);
	const mark = await page.evaluate(() => performance.now());
	const detail = await action();
	await waitForSettle(page, network, { quietMs: 800, maxMs: 15_000 });
	await sleep(300);
	const result = await page.evaluate(finishGeometry);
	const shifts = await page.evaluate(
		(since) => (window.__perfProbe?.shifts ?? []).filter((s) => s.startTime >= since),
		mark,
	);
	const positional = result.moved.filter((m) => m.dx > 1 || m.dy > 1);
	return {
		passed: positional.length === 0,
		tracked: result.tracked,
		moved: positional,
		resized: result.moved.filter((m) => m.dx <= 1 && m.dy <= 1),
		cls: Math.round(computeCls(shifts).value * 10000) / 10000,
		shiftsDuringInput: shifts.filter((s) => s.hadRecentInput).length,
		...detail,
	};
}

async function clickByName(page, names) {
	for (const name of names) {
		const button = page.getByRole("button", { name, exact: false });
		if ((await button.count()) > 0 && (await button.first().isVisible())) {
			await button.first().click();
			return true;
		}
	}
	return false;
}

async function focusEditorEnd(page) {
	const paragraph = page.locator(`${EDITOR_SELECTOR} p`).first();
	await paragraph.waitFor({ state: "visible", timeout: 15_000 });
	await paragraph.click();
	await page.keyboard.press("End");
}

const editorGeometry = { exclude: EDITOR_SELECTOR, belowSelector: EDITOR_SELECTOR };

const SCENARIOS = [
	{
		name: "editor typing",
		viewports: ["desktop", "mobile"],
		writes: true,
		async run({ page, network }) {
			await focusEditorEnd(page);
			await page.evaluate(() => {
				window.__perfKeys = [];
				document.addEventListener(
					"keydown",
					(e) => {
						const t = e.timeStamp;
						requestAnimationFrame(() =>
							setTimeout(() => window.__perfKeys.push(performance.now() - t)),
						);
					},
					true,
				);
			});
			const mark = await page.evaluate(() => performance.now());
			const text = " Typing in a long entry should stay smooth.";
			const result = await watch(
				page,
				network,
				async () => {
					await page.keyboard.type(text, { delay: 60 });
					return {};
				},
				editorGeometry,
			);
			const keys = await page.evaluate(() => window.__perfKeys);
			const tasks = await page.evaluate(
				(since) => (window.__perfProbe?.longTasks ?? []).filter((t) => t.startTime >= since),
				mark,
			);
			return {
				...result,
				keystrokes: keys.length,
				keyToFrameP50Ms: percentile(keys, 50),
				keyToFrameP95Ms: percentile(keys, 95),
				keyToFrameMaxMs: percentile(keys, 100),
				longTasks: tasks.length,
				longTaskMs: Math.round(tasks.reduce((s, t) => s + t.duration, 0)),
				summary: `${keys.length} keys, input-to-frame p95 ${percentile(keys, 95)} ms, max ${percentile(keys, 100)} ms`,
			};
		},
		path: ({ heaviest }) => `${ADMIN}/content/${heaviest.collection}/${heaviest.id}`,
	},
	{
		name: "editor autosave and save",
		viewports: ["desktop"],
		writes: true,
		path: ({ heaviest }) => `${ADMIN}/content/${heaviest.collection}/${heaviest.id}`,
		async run({ page, network, heaviest }) {
			await focusEditorEnd(page);
			const writes = [];
			page.on("request", (r) => {
				if (
					r.method() !== "GET" &&
					r.url().includes(`/content/${heaviest.collection}/${heaviest.id}`)
				) {
					writes.push(`${r.method()} ${new URL(r.url()).pathname.split("/").slice(-1)[0]}`);
				}
			});
			const autosave = await watch(
				page,
				network,
				async () => {
					await page.keyboard.type(" Autosave check.", { delay: 40 });
					await sleep(3500);
					return {};
				},
				editorGeometry,
			);
			const autosaved = writes.length > 0;
			const save = await watch(
				page,
				network,
				async () => {
					await page.keyboard.type(" Saved by hand.", { delay: 40 });
					const clicked = await clickByName(page, SAVE_BUTTONS);
					return { clicked };
				},
				editorGeometry,
			);
			return {
				passed: autosave.passed && save.passed,
				moved: [...autosave.moved, ...save.moved],
				cls: Math.max(autosave.cls, save.cls),
				autosaved,
				saveClicked: save.clicked,
				writes,
				summary: `autosave ${autosaved ? "sent" : "not seen"}; save button ${save.clicked ? "clicked" : "not found"}; requests: ${writes.join(", ") || "none"}`,
			};
		},
	},
	{
		name: "editor save error",
		viewports: ["desktop"],
		writes: true,
		path: ({ heaviest }) => `${ADMIN}/content/${heaviest.collection}/${heaviest.id}`,
		async before({ context, site, heaviest }) {
			await context.route(
				(url) =>
					url
						.toString()
						.startsWith(`${site.origin}/_emdash/api/content/${heaviest.collection}/${heaviest.id}`),
				(route) => {
					if (route.request().method() === "GET") return route.fallback();
					return route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({
							success: false,
							error: { code: "INTERNAL_ERROR", message: "Simulated save failure" },
						}),
					});
				},
			);
		},
		async run({ page, network }) {
			await focusEditorEnd(page);
			const result = await watch(
				page,
				network,
				async () => {
					await page.keyboard.type(" This save fails.", { delay: 40 });
					const clicked = await clickByName(page, SAVE_BUTTONS);
					await sleep(3000);
					return { clicked };
				},
				editorGeometry,
			);
			const alerts = await page.locator('[role="alert"], [role="status"]').allInnerTexts();
			return {
				...result,
				errorShown: alerts.some((t) => ERROR_TEXT.test(t)),
				summary: `save ${result.clicked ? "clicked" : "autosave only"}; error shown: ${alerts.some((t) => ERROR_TEXT.test(t))}`,
			};
		},
	},
	{
		name: "editor save conflict",
		viewports: ["desktop"],
		writes: true,
		path: ({ heaviest }) => `${ADMIN}/content/${heaviest.collection}/${heaviest.id}`,
		async run({ page, network, site, cookies, heaviest }) {
			await focusEditorEnd(page);
			const api = apiClient(site.origin, cookies);
			const current = await api("GET", `/content/${heaviest.collection}/${heaviest.id}`);
			const entry = current.item ?? current;
			let conflictWrite = "ok";
			try {
				await api("PUT", `/content/${heaviest.collection}/${heaviest.id}`, {
					data: { title: `${entry.data?.title ?? "Entry"} (edited elsewhere)` },
					_rev: current._rev ?? entry._rev,
					overrideLock: true,
				});
			} catch (error) {
				conflictWrite = String(error.message).slice(0, 120);
			}
			const statuses = [];
			page.on("response", (r) => {
				if (
					r.request().method() !== "GET" &&
					r.url().includes(`/content/${heaviest.collection}/`)
				) {
					statuses.push(r.status());
				}
			});
			const result = await watch(
				page,
				network,
				async () => {
					await page.keyboard.type(" Conflicting edit.", { delay: 40 });
					const clicked = await clickByName(page, SAVE_BUTTONS);
					await sleep(3000);
					return { clicked };
				},
				editorGeometry,
			);
			return {
				...result,
				conflictWrite,
				responseStatuses: statuses,
				summary: `other-session write: ${conflictWrite}; save responses: ${statuses.join(", ") || "none"}`,
			};
		},
	},
	{
		name: "dialogs and command palette",
		viewports: ["desktop", "mobile"],
		writes: false,
		path: () => `${ADMIN}/media`,
		async run({ page, network }) {
			const palette = await watch(page, network, async () => {
				await page.keyboard.press("Control+k");
				await sleep(800);
				const open = await page.locator('[role="dialog"], [role="combobox"]').count();
				await page.keyboard.press("Escape");
				await sleep(500);
				return { paletteOpened: open > 0 };
			});
			const dialog = await watch(page, network, async () => {
				const opened = await clickByName(page, UPLOAD_BUTTON);
				await sleep(800);
				await page.keyboard.press("Escape");
				await sleep(500);
				return { dialogOpened: opened };
			});
			return {
				passed: palette.passed && dialog.passed,
				moved: [...palette.moved, ...dialog.moved],
				cls: Math.max(palette.cls, dialog.cls),
				summary: `palette ${palette.paletteOpened ? "opened" : "did not open"}, upload dialog ${dialog.dialogOpened ? "opened" : "not found"}`,
			};
		},
	},
	{
		name: "navigate admin sections",
		viewports: ["desktop"],
		writes: false,
		path: () => `${ADMIN}/`,
		async run({ page, network }) {
			const visits = [];
			let passed = true;
			const moved = [];
			let cls = 0;
			for (const href of ["/content/posts", "/media", "/settings", "/users", "/"]) {
				const link = page
					.locator(`aside a[href$="${ADMIN}${href}"], nav a[href$="${ADMIN}${href}"]`)
					.first();
				if ((await link.count()) === 0) {
					visits.push(`${href}: no link`);
					continue;
				}
				const r = await watch(
					page,
					network,
					async () => {
						await link.click();
						return {};
					},
					{ exclude: "main" },
				);
				passed &&= r.passed;
				moved.push(...r.moved);
				cls = Math.max(cls, r.cls);
				visits.push(`${href}: ${r.passed ? "ok" : "moved"}`);
			}
			return { passed, moved, cls, summary: visits.join("; ") };
		},
	},
	{
		name: "navigate from the phone menu",
		viewports: ["mobile"],
		writes: false,
		path: () => `${ADMIN}/`,
		async run({ page, network }) {
			const trigger = page.locator("header button").first();
			const r = await watch(
				page,
				network,
				async () => {
					await trigger.click();
					await sleep(600);
					const link = page.locator(`a[href$="${ADMIN}/media"]`).first();
					const found = (await link.count()) > 0 && (await link.isVisible());
					if (found) await link.click();
					return { linkFound: found };
				},
				{ exclude: "main" },
			);
			return {
				...r,
				summary: `menu link ${r.linkFound ? "followed" : "not visible"}; now at ${new URL(page.url()).pathname}`,
			};
		},
	},
	{
		name: "upload media",
		viewports: ["desktop"],
		writes: true,
		path: () => `${ADMIN}/media`,
		async run({ page, network, mediaFile }) {
			const r = await watch(
				page,
				network,
				async () => {
					await clickByName(page, UPLOAD_BUTTON);
					const [response] = await Promise.all([
						page.waitForResponse(
							(res) =>
								res.request().method() === "POST" && res.url().includes("/_emdash/api/media"),
							{ timeout: 60_000 },
						),
						page.locator('input[type="file"][multiple]').setInputFiles(mediaFile),
					]);
					await sleep(1000);
					await page.keyboard.press("Escape");
					return { uploadStatus: response.status() };
				},
				{ exclude: "main .grid" },
			);
			return { ...r, summary: `upload ${r.uploadStatus}` };
		},
	},
	{
		name: "failed API request",
		viewports: ["desktop"],
		writes: false,
		async run({ page, network, context, site, collection }) {
			await context.route(
				(url) => url.pathname === `/_emdash/api/content/${collection}`,
				async (route) => {
					await sleep(1500);
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({
							success: false,
							error: { code: "INTERNAL_ERROR", message: "Simulated failure" },
						}),
					});
				},
			);
			await page.goto(`${site.origin}${ADMIN}/content/${collection}`, { waitUntil: "load" });
			await sleep(700);
			const r = await watch(page, network, async () => {
				await sleep(2500);
				return {};
			});
			const text = await page
				.locator("main")
				.innerText()
				.catch(() => "");
			return {
				...r,
				errorShown: LIST_ERROR_TEXT.test(text),
				summary: `error message ${LIST_ERROR_TEXT.test(text) ? "shown" : "not found"}`,
			};
		},
	},
	{
		name: "offline navigation to an unloaded screen",
		viewports: ["desktop"],
		writes: false,
		path: () => `${ADMIN}/`,
		async run({ page, network, context }) {
			const before = network.requests.length;
			const link = page
				.locator(
					`aside a[href$="${ADMIN}/content-types"], aside a[href$="${ADMIN}/import/wordpress"]`,
				)
				.first();
			if ((await link.count()) === 0)
				return { passed: null, summary: "no link to an unloaded screen" };
			await context.setOffline(true);
			try {
				const r = await watch(
					page,
					network,
					async () => {
						await link.click();
						await sleep(3000);
						return {};
					},
					{ exclude: "main" },
				);
				const text = (
					await page
						.locator("main")
						.innerText()
						.catch(() => "")
				).trim();
				const failed = network.requests.slice(before).filter((q) => q.failed);
				return {
					...r,
					failedRequests: failed.map((q) => q.url.replace(ORIGIN_PREFIX, "")),
					mainTextLength: text.length,
					errorShown: OFFLINE_ERROR_TEXT.test(text),
					summary: `${failed.length} request(s) failed offline; main shows ${text.length} characters; error message ${OFFLINE_ERROR_TEXT.test(text) ? "shown" : "not found"}`,
				};
			} finally {
				await context.setOffline(false);
			}
		},
	},
];

export async function runScenarios({
	browser,
	site,
	cookies,
	options,
	prepared,
	ledger,
	ensureClean,
	log,
	mediaFile,
	screenshotDir,
}) {
	const heaviestEntry = prepared.seed.edits?.heaviestEntry;
	const collection = prepared.seed.edits?.collection ?? "pages";
	const heaviest = heaviestEntry ? { ...heaviestEntry, collection } : null;
	const results = [];
	mkdirSync(screenshotDir, { recursive: true });
	for (const scenario of SCENARIOS) {
		for (const viewport of scenario.viewports.filter((v) => options.viewports.includes(v))) {
			const name = `${scenario.name} (${viewport})`;
			if (scenario.name.startsWith("editor") && !heaviest) {
				results.push({ name, passed: null, summary: "no image-heavy entry in this template" });
				continue;
			}
			try {
				await ensureClean(name);
			} catch (error) {
				results.push({ name, viewport, passed: null, error: String(error).split("\n")[0] });
				continue;
			}
			const phase = `scenario:${name.replace(NON_SLUG, "-")}`;
			const ctx = await openAdmin(browser, { site, cookies, options, viewport, phase });
			const args = { ...ctx, site, cookies, heaviest, collection, mediaFile, viewport };
			try {
				await scenario.before?.(args);
				if (scenario.path) {
					await ctx.page.goto(`${site.origin}${scenario.path({ heaviest })}`, {
						waitUntil: "load",
					});
					await waitForSettle(ctx.page, ctx.network);
				}
				const result = await scenario.run(args);
				const screenshot = join(screenshotDir, `${phase.slice("scenario:".length)}.png`);
				await ctx.page.screenshot({ path: screenshot }).catch(() => {});
				results.push({ name, viewport, screenshot, ...result });
				log(
					`  scenario ${name.padEnd(46)} ${result.passed === false ? "MOVED" : result.passed ? "ok" : "-"}  ${result.summary ?? ""}`,
				);
			} catch (error) {
				results.push({
					name,
					viewport,
					passed: null,
					error: String(error).split("\n")[0].slice(0, 300),
				});
				log(`  scenario ${name}: error: ${String(error).split("\n")[0].slice(0, 200)}`);
			} finally {
				await ctx.context.close();
				const sql = site.queryEvents.filter((e) => e.phase === phase).map((e) => e.sql);
				ledger.record(name, { declaredWrites: scenario.writes, observedSql: sql });
			}
		}
	}
	return results;
}
