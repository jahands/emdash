/**
 * Scenarios for transient and failure states: editor save, autosave, conflict
 * and error states, failed and missing data, offline navigation, uploads,
 * dialogs and toasts. Each records the bounding boxes of named elements per
 * step in `.perf-audit/states/<key>.json`, so movement CLS ignores (shifts
 * within 500ms of input, transforms) is still visible.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { openFromSidebar } from "./navigation.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const STATES_DIR = join(ROOT, ".perf-audit/states");
const fixtureRequire = createRequire(join(ROOT, "fixtures/perf-site/package.json"));

const admin = (path) => `/_emdash/admin${path}`;
const API_HEADERS = { "X-EmDash-Request": "1", "Content-Type": "application/json" };
const SAVE_LABEL = /^Save$/;
const SAVE_PREFIX = /^Save/;
const UPLOAD_PREFIX = /^Upload/;
const CONTENT_ITEM_PATH = /\/_emdash\/api\/content\/posts\/[^/]+$/;
const FAILING_LOADS = [
	["posts list fails", /\/_emdash\/api\/content\/posts(\?|$)/, "/content/posts", "list failed"],
	[
		"editor load fails",
		/\/_emdash\/api\/content\/posts\/[^/?]+(\?|$)/,
		"/content/posts/$id",
		"editor failed",
	],
	["dashboard fails", /\/_emdash\/api\/dashboard/, "/", "dashboard failed"],
	["media fails", /\/_emdash\/api\/media(\?|$)/, "/media", "media failed"],
	["manifest fails", /\/_emdash\/api\/manifest/, "/", "manifest failed"],
];

const EDITOR_BOXES = {
	header: "main header, [data-editor-toolbar], .emdash-editor-toolbar",
	title: "main h1, main input[name='title'], main [data-field='title']",
	editor: ".ProseMirror",
	alerts: "[role='alert']",
	dialogs: "[role='dialog'], [role='alertdialog']",
	toasts: "[data-sonner-toast], [role='status']:not(.sr-only), [data-toast], ol[aria-label] li",
};

async function boxes(page, selectors) {
	return page.evaluate((map) => {
		const result = {};
		for (const [name, selector] of Object.entries(map)) {
			result[name] = [...document.querySelectorAll(selector)]
				.filter((element) => {
					const style = getComputedStyle(element);
					return style.display !== "none" && style.visibility !== "hidden";
				})
				.slice(0, 6)
				.map((element) => {
					const { x, y, width, height } = element.getBoundingClientRect();
					return {
						x: Math.round(x),
						y: Math.round(y),
						width: Math.round(width),
						height: Math.round(height),
						text: (element.textContent ?? "").trim().replaceAll(/\s+/g, " ").slice(0, 80),
					};
				});
		}
		return result;
	}, selectors);
}

function recorder(page, key, selectors = EDITOR_BOXES) {
	const samples = [];
	return {
		async sample(label) {
			mkdirSync(STATES_DIR, { recursive: true });
			const screenshot = join(
				STATES_DIR,
				`${key}-${samples.length}-${label}`.replaceAll(/[^a-z0-9-]+/gi, "_") + ".png",
			);
			await page.screenshot({ path: screenshot }).catch(() => {});
			samples.push({ label, at: Date.now(), screenshot, boxes: await boxes(page, selectors) });
		},
		save() {
			mkdirSync(STATES_DIR, { recursive: true });
			writeFileSync(
				join(STATES_DIR, `${key.replaceAll(/[^a-z0-9-]+/gi, "_")}.json`),
				JSON.stringify(samples, null, "\t"),
			);
		},
	};
}

function pngBuffer(seed) {
	const sharp = fixtureRequire("sharp");
	return sharp({
		create: {
			width: 1600,
			height: 1000,
			channels: 3,
			background: { r: (seed * 70) % 255, g: 120, b: 200 },
		},
	})
		.png()
		.toBuffer();
}

async function updateEntryBehindEditor(page, baseUrl, id) {
	const response = await page.request.put(`${baseUrl}/_emdash/api/content/posts/${id}`, {
		headers: { ...API_HEADERS, Origin: baseUrl },
		data: { data: { title: `Changed elsewhere ${Date.now()}` }, overrideLock: true },
	});
	if (!response.ok())
		throw new Error(`Concurrent update failed (${response.status()}): ${await response.text()}`);
}

/**
 * Fails when the entry is not published as seeded, so a scenario about the
 * first change to a published entry cannot silently start from a later state.
 */
async function assertPublishedWithoutChanges(page, baseUrl, id) {
	const response = await page.request.get(`${baseUrl}/_emdash/api/content/posts/${id}`);
	if (!response.ok()) throw new Error(`Reading ${id} failed (${response.status()})`);
	const body = await response.json();
	const item = body.data?.item ?? body.item;
	const hasChanges = item?.draftRevisionId && item.draftRevisionId !== item.liveRevisionId;
	if (!item?.liveRevisionId || hasChanges)
		throw new Error(`Entry ${id} must start published without draft changes; it did not`);
}

const editorTop = (page) =>
	page
		.locator(".ProseMirror")
		.first()
		.evaluate((element) => Math.round(element.getBoundingClientRect().top));

const clickSave = (page) => page.getByRole("button", { name: SAVE_LABEL }).first().click();

const contentSave = (url, method) =>
	(method === "PUT" || method === "PATCH" || method === "POST") &&
	CONTENT_ITEM_PATH.test(new URL(url).pathname);

export const STATE_SCENARIOS = [
	{
		id: "scenario:editor-save-states",
		async run({ page, step, params, viewportName }) {
			const rec = recorder(page, `editor-save-states-${viewportName}`);
			const editor = page.locator(".ProseMirror").first();
			const saveButton = page.getByRole("button", { name: SAVE_LABEL }).first();
			// Saves by button where there is one (wide screens), otherwise by autosave,
			// and returns once the save request has been sent.
			const typeAndSave = async (text) => {
				const sent = page.waitForRequest(
					(request) => contentSave(request.url(), request.method()),
					{
						timeout: 15_000,
					},
				);
				await editor.focus();
				await page.keyboard.type(text);
				await rec.sample(`dirty: ${text}`);
				if (await saveButton.isVisible()) await saveButton.click();
				await sent;
			};
			await step("load editor", () =>
				page.goto(admin(`/content/posts/${params.shortPostId}`), { waitUntil: "commit" }),
			);
			await rec.sample("loaded");
			let release;
			const gate = new Promise((resolveGate) => {
				release = resolveGate;
			});
			const held = (route) =>
				contentSave(route.request().url(), route.request().method())
					? gate.then(() => route.continue())
					: route.continue();
			await page.route("**/_emdash/api/content/posts/**", held);
			await step("type and save (held)", async () => {
				await typeAndSave("Held. ");
				await page.waitForTimeout(400);
				await rec.sample("saving");
				release();
			});
			await rec.sample("saved");
			await page.unroute("**/_emdash/api/content/posts/**", held);
			const failing = (route) =>
				contentSave(route.request().url(), route.request().method())
					? route.fulfill({
							status: 500,
							contentType: "application/json",
							body: JSON.stringify({
								error: { code: "CONTENT_UPDATE_ERROR", message: "Simulated failure" },
							}),
						})
					: route.continue();
			await page.route("**/_emdash/api/content/posts/**", failing);
			await step("type and save (fails)", () => typeAndSave("Fails. "));
			await rec.sample("save error");
			await page.unroute("**/_emdash/api/content/posts/**", failing);
			await step("type and save (recovers)", () => typeAndSave("Recovers. "));
			await rec.sample("after retry");
			rec.save();
		},
	},
	{
		id: "scenario:editor-autosave",
		async run({ page, step, params, viewportName }) {
			const rec = recorder(page, `editor-autosave-${viewportName}`);
			await step("load editor", () =>
				page.goto(admin(`/content/posts/${params.shortPostId}`), { waitUntil: "commit" }),
			);
			await rec.sample("loaded");
			const editor = page.locator(".ProseMirror").first();
			await step("type and wait for autosave", async () => {
				const sent = page.waitForRequest(
					(request) => contentSave(request.url(), request.method()),
					{
						timeout: 15_000,
					},
				);
				await editor.focus();
				await page.keyboard.type("Waiting for autosave. ");
				await rec.sample("dirty");
				await sent;
				await rec.sample("autosave fired");
			});
			await rec.sample("autosaved");
			rec.save();
		},
	},
	{
		id: "scenario:editor-first-save",
		async run({ page, step, params, baseUrl, viewportName }) {
			const rec = recorder(page, `editor-first-save-${viewportName}`);
			const moved = [];
			const editAndSave = async (label, id, save) => {
				await assertPublishedWithoutChanges(page, baseUrl, id);
				await step(`load ${label} entry`, () =>
					page.goto(admin(`/content/posts/${id}`), { waitUntil: "commit" }),
				);
				await step(`${label}: focus editor`, () =>
					page
						.locator(".ProseMirror")
						.first()
						.click({ position: { x: 20, y: 20 } }),
				);
				await rec.sample(`${label}: before`);
				const before = await editorTop(page);
				await step(label, async () => {
					const saved = page.waitForResponse(
						(response) => contentSave(response.url(), response.request().method()),
						{ timeout: 15_000 },
					);
					await page.keyboard.type("First change. ");
					await save();
					if (!(await saved).ok()) throw new Error(`${label} request failed`);
				});
				await rec.sample(`${label}: after`);
				const after = await editorTop(page);
				if (Math.abs(after - before) > 1)
					moved.push(`${label} moved the editor ${after - before}px (top ${before} -> ${after})`);
			};
			await editAndSave("first autosave", params.firstAutosavePostId, async () => {});
			// Phones show no Save button for a published entry with autosave, so autosave saves it there.
			await editAndSave("first save", params.firstSavePostId, async () => {
				const save = page.getByRole("button", { name: SAVE_LABEL }).first();
				if (await save.isVisible()) await save.click();
			});
			rec.save();
			if (moved.length > 0) throw new Error(moved.join("; "));
		},
	},
	{
		id: "scenario:editor-conflict",
		async run({ page, step, params, baseUrl, viewportName }) {
			const rec = recorder(page, `editor-conflict-${viewportName}`);
			await step("load editor", () =>
				page.goto(admin(`/content/posts/${params.shortPostId}`), { waitUntil: "commit" }),
			);
			await rec.sample("loaded");
			const editor = page.locator(".ProseMirror").first();
			await step("type (dirty)", async () => {
				await editor.focus();
				await page.keyboard.type("Local change. ");
			});
			await step("change entry elsewhere", () =>
				updateEntryBehindEditor(page, baseUrl, params.shortPostId),
			);
			await step("save (conflict)", () => clickSave(page));
			await rec.sample("conflict");
			await step("settle after conflict", () => page.waitForTimeout(1500));
			await rec.sample("conflict settled");
			rec.save();
		},
	},
	{
		id: "scenario:failed-requests",
		async run({ page, step, params, viewportName }) {
			const rec = recorder(page, `failed-requests-${viewportName}`, {
				main: "main",
				alerts: "[role='alert']",
				headings: "main h1, main h2",
				buttons: "main button",
			});
			const fail = (pattern) =>
				page.route(pattern, (route) =>
					route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Simulated" } }),
					}),
				);
			for (const [name, pattern, path, label] of FAILING_LOADS) {
				await fail(pattern);
				await step(name, () =>
					page.goto(admin(path.replace("$id", params.shortPostId)), { waitUntil: "commit" }),
				);
				await rec.sample(label);
				await page.unroute(pattern);
			}
			rec.save();
		},
	},
	{
		id: "scenario:offline-navigation",
		async run({ page, step, viewportName }) {
			const rec = recorder(page, `offline-navigation-${viewportName}`, {
				main: "main",
				alerts: "[role='alert']",
				headings: "main h1, main h2",
				status: "[role='status']",
			});
			await step("load dashboard", () => page.goto(admin("/"), { waitUntil: "commit" }));
			await page.context().setOffline(true);
			const openLink = (suffix) =>
				openFromSidebar(
					page,
					viewportName,
					page.locator(`.emdash-sidebar a[href$='${suffix}']`).first(),
					{
						timeout: 3000,
					},
				);
			await step("open Posts offline (screen loaded before)", async () => {
				await openLink("/content/posts");
				await page.waitForTimeout(1500);
			});
			await rec.sample("posts offline");
			await step("open Settings offline (screen not loaded)", async () => {
				await openLink("/settings");
				await page.waitForTimeout(1500);
			});
			await rec.sample("settings offline");
			await page.context().setOffline(false);
			await step("back online, open Media", () => openLink("/media"));
			await rec.sample("media online");
			rec.save();
		},
	},
	{
		id: "scenario:stale-chunk",
		async run({ page, step, viewportName }) {
			const rec = recorder(page, `stale-chunk-${viewportName}`, {
				main: "main",
				alerts: "[role='alert']",
				headings: "main h1, main h2, h1",
			});
			await step("load dashboard", () => page.goto(admin("/"), { waitUntil: "commit" }));
			const loaded = new Set(
				await page.evaluate(() =>
					performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname),
				),
			);
			// Chunks the open page has not loaded yet fail once, as after a deploy
			// replaced them; a reload then gets chunks that exist.
			const failed = new Set();
			await page.route("**/_astro/*.js", (route) => {
				const path = new URL(route.request().url()).pathname;
				if (loaded.has(path) || failed.has(path)) return route.continue();
				failed.add(path);
				return route.fulfill({ status: 404, body: "Not found" });
			});
			await step("open Settings after deploy", async () => {
				await openFromSidebar(
					page,
					viewportName,
					page.locator(".emdash-sidebar a[href$='/settings']").first(),
				);
				await page.waitForTimeout(300);
				await rec.sample("settings 300ms after click");
				await page.waitForTimeout(1200);
			});
			await rec.sample("settings chunk missing");
			rec.save();
		},
	},
	{
		id: "scenario:empty-collection",
		async run({ page, step, baseUrl, viewportName }) {
			const rec = recorder(page, `empty-collection-${viewportName}`, {
				main: "main",
				headings: "main h1, main h2",
				table: "main table",
				empty: "main [data-empty-state], main p",
			});
			const slug = `empty_${viewportName}`;
			const created = await page.request.post(`${baseUrl}/_emdash/api/schema/collections`, {
				headers: { ...API_HEADERS, Origin: baseUrl },
				data: { slug, label: "Empty things", labelSingular: "Empty thing" },
			});
			if (!created.ok())
				throw new Error(`Collection create failed (${created.status()}): ${await created.text()}`);
			await step("open empty collection", () =>
				page.goto(admin(`/content/${slug}`), { waitUntil: "commit" }),
			);
			await rec.sample("empty list");
			await step("open trash tab", () => page.getByRole("tab", { name: "Trash" }).click());
			await rec.sample("empty trash");
			await step("search with no results", async () => {
				await page.goto(admin("/content/posts"), { waitUntil: "commit" });
				await page.locator('input[aria-label^="Search"]').fill("zzzz-no-such-post");
			});
			await rec.sample("no search results");
			rec.save();
		},
	},
	{
		id: "scenario:media-upload",
		async run({ page, step, viewportName }) {
			const rec = recorder(page, `media-upload-${viewportName}`, {
				grid: "[data-media-grid]",
				gridItems: "[data-media-grid] button",
				dialogs: "[role='dialog']",
				alerts: "[role='alert']",
				headings: "main h1",
			});
			await step("load media", () => page.goto(admin("/media"), { waitUntil: "commit" }));
			await rec.sample("loaded");
			await step("open upload dialog", () =>
				page.getByRole("button", { name: UPLOAD_PREFIX }).first().click(),
			);
			await rec.sample("dialog open");
			const files = await Promise.all(
				[1, 2, 3].map(async (seed) => ({
					name: `upload-${seed}.png`,
					mimeType: "image/png",
					buffer: await pngBuffer(seed),
				})),
			);
			await step("add three files", async () => {
				await page.locator('input[type="file"]').first().setInputFiles(files);
				await page.waitForTimeout(150);
				await rec.sample("uploading");
			});
			await rec.sample("uploaded");
			await step("close upload dialog", () =>
				page.getByRole("button", { name: "Done" }).first().click(),
			);
			await rec.sample("closed");
			rec.save();
		},
	},
	{
		id: "scenario:dialogs-toasts",
		async run({ page, step, viewportName }) {
			const rec = recorder(page, `dialogs-toasts-${viewportName}`, {
				dialogs: "[role='dialog'], [role='alertdialog']",
				toasts: EDITOR_BOXES.toasts,
				headings: "main h1",
			});
			await step("open users", () => page.goto(admin("/users"), { waitUntil: "commit" }));
			await step("open invite dialog", () =>
				page.getByRole("button", { name: "Invite User" }).first().click(),
			);
			await rec.sample("invite open");
			await step("close invite dialog", () => page.keyboard.press("Escape"));
			await step("open redirects", () => page.goto(admin("/redirects"), { waitUntil: "commit" }));
			await step("open new redirect", () =>
				page.getByRole("button", { name: "New Redirect" }).first().click(),
			);
			await rec.sample("redirect open");
			await step("close new redirect", () => page.keyboard.press("Escape"));
			await step("open sections", () => page.goto(admin("/sections"), { waitUntil: "commit" }));
			await step("open new section", () =>
				page.getByRole("button", { name: "New section" }).first().click(),
			);
			await rec.sample("section open");
			await step("close new section", () => page.keyboard.press("Escape"));
			await step("open general settings", () =>
				page.goto(admin("/settings/general"), { waitUntil: "commit" }),
			);
			await step("edit and save (toast)", async () => {
				const input = page.locator("main input[type='text'], main input:not([type])").first();
				await input.fill(`My Blog ${Date.now() % 1000}`);
				await page.getByRole("button", { name: SAVE_PREFIX }).first().click();
				await page.waitForTimeout(300);
				await rec.sample("toast");
			});
			await rec.sample("after toast");
			rec.save();
		},
	},
];
