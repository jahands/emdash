import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { chromium } from "@playwright/test";

import { coldBurstFailures, evaluateBudgets, failedResponses } from "../lib/evaluate.mjs";
import { exitCode, pageProblems, runFailures } from "../lib/failures.mjs";
import { measurePage } from "../lib/page-run.mjs";
import { renderSummary } from "../lib/report.mjs";
import { buildTargets } from "../lib/targets.mjs";
import { measureWrites } from "../lib/writes.mjs";

const ORIGIN = "http://localhost:4321";

const renderedPage = (over = {}) => ({
	name: "public home",
	viewport: "desktop",
	url: "/",
	status: 200,
	content: { expected: { selector: "main" }, found: true, booting: false, images: 3 },
	waterfall: [],
	...over,
});

const profile = (over = {}) => ({
	profile: "blog-node-sqlite",
	origin: ORIGIN,
	pages: [renderedPage()],
	scenarios: [],
	errors: [],
	failedResponses: [],
	coldStart: {
		publicPage: { path: "/", status: 200, ttfbMs: 100 },
		adminApi: { path: "/_emdash/api/auth/me", status: 200, ttfbMs: 50 },
	},
	...over,
});

const run = (over = {}) => ({
	name: "test",
	options: { only: [], viewports: ["desktop"], dbLatency: 0, locale: "en" },
	distorting: [],
	workspace: { path: "/w", revision: null },
	profiles: [profile()],
	errors: [],
	budgetFailures: [],
	burstFailures: [],
	...over,
});

function listen(handler) {
	const server = createServer(handler);
	return new Promise((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const origin = `http://127.0.0.1:${server.address().port}`;
			resolve({ origin, close: () => new Promise((r) => server.close(r)) });
		}),
	);
}

async function launchOrSkip(t) {
	try {
		return await chromium.launch({ headless: true });
	} catch (error) {
		t.skip(`Chromium is not installed: ${String(error).split("\n")[0]}`);
		return null;
	}
}

void test("a clean run exits 0", () => {
	assert.deepEqual(runFailures(run()), []);
	assert.equal(exitCode(run()), 0);
});

void test("a failed write fails the run without any budget (reviewer reproduction)", async () => {
	const observed = [];
	const server = await listen((req, res) => {
		observed.push(`${req.method} ${req.url}`);
		res.setHeader("Content-Type", "application/json");
		if (req.method === "GET" && req.url === "/_emdash/api/media?limit=100") {
			res.end(
				JSON.stringify({
					data: {
						items: [
							{
								id: "photo",
								mimeType: "image/jpeg",
								url: "/photo.jpg",
								filename: "photo.jpg",
								width: 1,
								height: 1,
							},
						],
					},
				}),
			);
			return;
		}
		res.statusCode = 500;
		res.end(JSON.stringify({ error: { message: "simulated broken create" } }));
	});
	try {
		const site = { origin: server.origin, queryEvents: [], watchCommits: () => null };
		const pass = await measureWrites(site, {
			cookies: [],
			plan: { collection: "posts", titleField: "title", imageField: "image", bodyField: "body" },
			heaviest: { id: "heavy" },
		});
		assert.deepEqual(observed, [
			"GET /_emdash/api/media?limit=100",
			"POST /_emdash/api/content/posts",
		]);
		assert.equal(pass.ops[0].status, 500);
		const p = profile({
			origin: server.origin,
			pages: [],
			writes: pass.ops,
			errors: [{ measurement: "writes", error: pass.error }],
		});
		p.failedResponses = failedResponses(p, server.origin);
		const r = run({
			profiles: [p],
			budgetFailures: evaluateBudgets([p], {}),
			burstFailures: coldBurstFailures([p]),
		});
		assert.deepEqual(r.budgetFailures, []);
		assert.deepEqual(r.burstFailures, []);
		assert.deepEqual(
			runFailures(r).map((f) => [f.check, f.where]),
			[
				["measurement failed", "writes"],
				["server error", "write create"],
			],
		);
		assert.equal(exitCode(r), 1);
	} finally {
		await server.close();
	}
});

void test("a profile that threw fails the run", () => {
	const r = run({ errors: [{ profile: "blog-node-sqlite", error: "Error: boom\n  at x" }] });
	assert.deepEqual(runFailures(r), [
		{ profile: "blog-node-sqlite", check: "profile failed", where: "", detail: "Error: boom" },
	]);
	assert.equal(exitCode(r), 1);
});

void test("any 5xx a measurement got back fails the run", () => {
	const r = run({
		profiles: [
			profile({
				failedResponses: [
					{ where: "desktop public home", path: "/_emdash/api/x", status: 503, count: 2 },
				],
			}),
		],
	});
	assert.deepEqual(runFailures(r), [
		{
			profile: "blog-node-sqlite",
			check: "server error",
			where: "desktop public home",
			detail: "503 /_emdash/api/x (2 times)",
		},
	]);
	assert.equal(exitCode(r), 1);
});

void test("a screen fails on an error status, a missing landmark, the boot loader, or too few images", () => {
	assert.deepEqual(pageProblems(renderedPage(), ORIGIN), []);
	assert.deepEqual(pageProblems(renderedPage({ status: 500 }), ORIGIN), ["document status 500"]);
	assert.deepEqual(pageProblems(renderedPage({ status: null }), ORIGIN), ["no document response"]);
	assert.deepEqual(
		pageProblems(
			renderedPage({
				content: { expected: { selector: "main" }, found: false, booting: true, images: 0 },
			}),
			ORIGIN,
		),
		["still showing the admin boot loader", "no main element"],
	);
	assert.deepEqual(
		pageProblems(
			renderedPage({
				content: {
					expected: { selector: "main", minImages: 1 },
					found: true,
					booting: false,
					images: 0,
				},
			}),
			ORIGIN,
		),
		["0 images, expected at least 1"],
	);
	assert.deepEqual(
		pageProblems(
			renderedPage({
				waterfall: [
					{ type: "Script", status: 404, url: `${ORIGIN}/_astro/app.js` },
					{ type: "Image", status: 404, url: "https://elsewhere.example/a.png" },
					{ type: "Fetch", status: 401, url: `${ORIGIN}/_emdash/api/auth/me` },
				],
			}),
			ORIGIN,
		),
		["script 404: /_astro/app.js"],
	);
	const r = run({ profiles: [profile({ pages: [renderedPage({ status: 404 })] })] });
	assert.deepEqual(
		runFailures(r).map((f) => [f.check, f.where, f.detail]),
		[["screen not rendered", "desktop public home", "document status 404"]],
	);
	assert.equal(exitCode(r), 1);
});

void test("every built screen says what it must render", () => {
	const targets = buildTargets({
		template: "blog",
		collections: ["posts"],
		heaviest: { id: "1", slug: "heavy", collection: "posts" },
		taxonomy: "category",
		term: "news",
		menu: "primary",
		firstPageSlug: null,
	});
	assert.deepEqual(
		targets.filter((t) => !t.expect?.selector).map((t) => t.name),
		[],
	);
});

void test("a scenario that errored fails the run, including one errored sample of several", () => {
	const errored = run({
		profiles: [
			profile({ scenarios: [{ name: "editor typing (desktop)", passed: null, error: "Timeout" }] }),
		],
	});
	assert.deepEqual(
		runFailures(errored).map((f) => [f.check, f.where, f.detail]),
		[["scenario errored", "editor typing (desktop)", "Timeout"]],
	);
	assert.equal(exitCode(errored), 1);
	const sampled = run({
		profiles: [
			profile({
				scenarios: [
					{
						name: "editor typing (desktop)",
						passed: true,
						samples: [{ passed: true }, { error: "page crashed" }],
					},
				],
			}),
		],
	});
	assert.equal(exitCode(sampled), 1);
	const skipped = run({
		profiles: [
			profile({ scenarios: [{ name: "x", passed: null, summary: "no image-heavy entry" }] }),
		],
	});
	assert.equal(exitCode(skipped), 0);
});

void test("a cold start that got an error status on any restart fails the run", () => {
	const r = run({
		profiles: [
			profile({
				coldStart: {
					publicPage: { path: "/", status: 200, samplesStatus: [200, 500, 200] },
					adminApi: { path: "/_emdash/api/auth/me", status: 401 },
				},
			}),
		],
	});
	assert.deepEqual(
		runFailures(r).map((f) => [f.check, f.where, f.detail]),
		[
			["cold start", "publicPage", "/ got 200, 500, 200"],
			["cold start", "adminApi", "/_emdash/api/auth/me got 401"],
		],
	);
	assert.equal(exitCode(r), 1);
});

void test("an empty query log fails the run", () => {
	const r = run({ profiles: [profile({ queryLog: "unavailable" })] });
	assert.deepEqual(
		runFailures(r).map((f) => f.check),
		["query log"],
	);
	assert.equal(exitCode(run({ profiles: [profile({ queryLog: "available" })] })), 0);
});

void test("query plans fail the run when a request or EXPLAIN failed, or nothing was explained", () => {
	const ok = { kind: "list", request: "/", sql: "select 1", executionMs: 1, flags: [] };
	assert.equal(exitCode(run({ profiles: [profile({ queryPlans: [ok] })] })), 0);
	assert.equal(exitCode(run({ profiles: [profile({ queryPlans: [] })] })), 1);
	const r = run({
		profiles: [
			profile({
				queryPlans: [ok, { kind: "sitemap", request: "/sitemap.xml", error: "status 500" }],
			}),
		],
	});
	assert.deepEqual(
		runFailures(r).map((f) => [f.check, f.where, f.detail]),
		[["query plans", "/sitemap.xml", "status 500"]],
	);
	const summary = renderSummary({
		...r,
		profiles: [profile({ pages: [], coldStart: undefined, queryPlans: r.profiles[0].queryPlans })],
		failures: runFailures(r),
	});
	assert.ok(summary.includes("## Failed checks"));
	assert.ok(summary.includes("| blog-node-sqlite | query plans | /sitemap.xml | status 500 |"));
});

void test("--only that selects nothing fails the run", () => {
	const nothing = { screens: 0, scenarios: 0, writes: false, queryPlans: false };
	const r = run({
		options: { ...run().options, only: ["typo"] },
		profiles: [profile({ pages: [], selected: nothing })],
	});
	assert.deepEqual(
		runFailures(r).map((f) => f.check),
		["nothing selected"],
	);
	assert.equal(exitCode(r), 1);
	const plans = run({
		options: { ...run().options, only: ["plan"] },
		profiles: [
			profile({ profile: "blog-node-sqlite", pages: [], selected: nothing }),
			profile({
				profile: "blog-node-postgres",
				pages: [],
				selected: { ...nothing, queryPlans: true },
				queryPlans: [{ kind: "list", request: "/", sql: "s", flags: [] }],
			}),
		],
	});
	assert.equal(exitCode(plans), 0);
	const failedPlans = run({
		options: { ...run().options, only: ["plan"] },
		profiles: [
			profile({
				pages: [],
				selected: { ...nothing, queryPlans: true },
				errors: [{ measurement: "query plans", error: "TypeError: fetch failed" }],
			}),
		],
	});
	assert.deepEqual(
		runFailures(failedPlans).map((f) => f.check),
		["measurement failed"],
	);
	assert.equal(exitCode(failedPlans), 1);
});

void test("failures in the --compare workspace fail the run too", () => {
	const r = run({
		compareProfiles: [profile({ errors: [{ measurement: "cold start", error: "fetch failed" }] })],
	});
	assert.deepEqual(
		runFailures(r).map((f) => f.profile),
		["blog-node-sqlite (compare)"],
	);
	assert.equal(exitCode(r), 1);
});

void test("budgets and cold-start bursts still fail the run on their own", () => {
	assert.equal(exitCode(run({ budgetFailures: [{ profile: "p", budget: "max-cls" }] })), 1);
	assert.equal(exitCode(run({ burstFailures: [{ profile: "p", failed: 1 }] })), 1);
	assert.equal(exitCode(run({ comparison: { rows: [], regressions: [{ profile: "p" }] } })), 0);
});

void test("measurePage records an HTTP 500 document that then fails the run", async (t) => {
	const browser = await launchOrSkip(t);
	if (!browser) return;
	const server = await listen((req, res) => {
		res.setHeader("Content-Type", "text/html");
		if (req.url === "/ok") {
			res.end("<!doctype html><title>ok</title><main><h1>Home</h1></main>");
			return;
		}
		res.statusCode = 500;
		res.end("<!doctype html><title>Server error</title><h1>Internal Server Error</h1>");
	});
	try {
		const site = { origin: server.origin, profile: { images: "sharp" } };
		const options = { locale: "en", cpu: 1, slowApi: 0, screenshots: false, hold: null };
		const measure = (path) =>
			measurePage({
				browser,
				site,
				target: { name: "public home", path, kind: "public", expect: { selector: "main" } },
				viewport: "desktop",
				cookies: null,
				options,
				phase: "test",
				paths: {},
			});
		const ok = await measure("/ok");
		assert.equal(ok.status, 200);
		assert.deepEqual(pageProblems(ok, server.origin), []);
		const broken = await measure("/");
		assert.equal(broken.status, 500);
		assert.deepEqual(pageProblems(broken, server.origin), [
			"document status 500",
			"no main element",
		]);
		const r = run({
			profiles: [
				profile({
					origin: server.origin,
					pages: [{ ...broken, name: "public home", viewport: "desktop" }],
				}),
			],
		});
		assert.equal(exitCode(r), 1);
	} finally {
		await server.close();
		await browser.close();
	}
});
