import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { chromium } from "@playwright/test";

import { DEFAULT_THRESHOLDS } from "../lib/args.mjs";
import { compareResults, confirmRegressions, pooledSamples } from "../lib/evaluate.mjs";
import { pageIncomplete, pageProblems } from "../lib/failures.mjs";
import { summarizeRequests } from "../lib/metrics.mjs";
import { measurePage, normalizeRequests, recordNetwork, waitForSettle } from "../lib/page-run.mjs";
import { describeConfirmation, renderSummary } from "../lib/report.mjs";
import { measureScreen } from "../lib/run-profile.mjs";

const SHELL = { selector: "main", heading: "main h1" };
const IN_FLIGHT = /1 request\(s\) in flight/;
const NOT_COMPARED = /1 screen\(s\) not compared/;
const INCOMPARABLE_ROW = /\| blog-node-sqlite \| mobile admin list posts \| before: still showing/;

const readyState = (over = {}) => ({
	expected: SHELL,
	found: true,
	heading: true,
	booting: false,
	images: 0,
	sinceShift: Infinity,
	...over,
});

void test("settling does not report settled while a request started during the page read is in flight (F-D reproduction)", async () => {
	const network = { inflight: 0, lastActivity: 0 };
	const page = {
		evaluate: async () => {
			await new Promise((r) => setTimeout(r, 25));
			network.inflight = 1;
			network.lastActivity = Date.now();
			return Infinity;
		},
	};
	const result = await waitForSettle(page, network, { quietMs: 10, maxMs: 1000 });
	assert.equal(result.settled, false);
	assert.match(result.reason, IN_FLIGHT);
});

void test("settling waits for a request started during the page read to finish", async () => {
	const network = { inflight: 0, lastActivity: 0 };
	let reads = 0;
	const page = {
		evaluate: async () => {
			reads++;
			if (reads === 1) {
				network.inflight = 1;
				network.lastActivity = Date.now();
				setTimeout(() => {
					network.inflight = 0;
					network.lastActivity = Date.now();
				}, 200);
			}
			return readyState();
		},
	};
	const result = await waitForSettle(page, network, { quietMs: 50, maxMs: 2000, expected: SHELL });
	assert.equal(result.settled, true);
	assert.equal(network.inflight, 0);
	assert.ok(result.ms >= 200, `settled after ${result.ms} ms`);
});

void test("settling waits for the screen's expected content, and says what is missing when it never appears", async () => {
	const network = { inflight: 0, lastActivity: 0 };
	let reads = 0;
	const booting = readyState({ booting: true, found: false, heading: false });
	const page = { evaluate: async () => (++reads < 4 ? booting : readyState()) };
	const ready = await waitForSettle(page, network, { quietMs: 10, maxMs: 2000, expected: SHELL });
	assert.equal(ready.settled, true);
	assert.equal(reads, 4);

	const spinner = { evaluate: async () => booting };
	const stuck = await waitForSettle(spinner, network, { quietMs: 10, maxMs: 400, expected: SHELL });
	assert.equal(stuck.settled, false);
	assert.equal(
		stuck.reason,
		"still showing the admin boot loader; no main element; no main h1 element",
	);

	const headless = { evaluate: async () => readyState({ heading: false }) };
	const noHeading = await waitForSettle(headless, network, {
		quietMs: 10,
		maxMs: 400,
		expected: SHELL,
	});
	assert.equal(noHeading.reason, "no main h1 element");
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

void test("measurePage waits past the admin boot loader instead of capturing the spinner", async (t) => {
	const browser = await launchOrSkip(t);
	if (!browser) return;
	const server = await listen((req, res) => {
		if (req.url.startsWith("/_emdash/api/")) {
			res.setHeader("Content-Type", "application/json");
			res.end('{"data":{}}');
			return;
		}
		res.setHeader("Content-Type", "text/html");
		res.end(`<!doctype html><title>admin</title>
<div id="emdash-boot-loader">Loading configuration</div>
<script>
setTimeout(async () => {
	await fetch("/_emdash/api/manifest");
	document.getElementById("emdash-boot-loader").remove();
	document.body.insertAdjacentHTML("beforeend", "<main><h1>Dashboard</h1></main>");
}, 1500);
</script>`);
	});
	try {
		const page = await measurePage({
			browser,
			site: { origin: server.origin, profile: { images: "sharp" } },
			target: { name: "admin dashboard", path: "/admin", kind: "admin", expect: SHELL },
			viewport: "desktop",
			cookies: null,
			options: { locale: "en", cpu: 1, slowApi: 0, screenshots: false, hold: null },
			phase: "test",
			paths: {},
		});
		assert.equal(page.settle.settled, true);
		assert.equal(page.content.booting, false);
		assert.equal(page.content.heading, true);
		assert.equal(page.api.count, 1);
		assert.deepEqual(pageProblems(page, server.origin), []);
	} finally {
		await server.close();
		await browser.close();
	}
});

void test("an incomplete capture is measured once more, an error document is not", async () => {
	const spinner = {
		status: 200,
		settle: { settled: false, ms: 25_000, reason: "1 request(s) in flight: /lib.js" },
		content: { expected: SHELL, found: false, heading: false, booting: true, images: 0 },
	};
	const rendered = { status: 200, settle: { settled: true, ms: 900 }, content: readyState() };
	const phases = [];
	let cleaned = 0;
	const queue = [spinner, rendered];
	const { page, phase } = await measureScreen(
		async (p) => {
			phases.push(p);
			return { ...queue.shift() };
		},
		{ phase: "page:desktop:x", beforeRetry: async () => cleaned++ },
	);
	assert.deepEqual(phases, ["page:desktop:x", "page:desktop:x:retry"]);
	assert.equal(phase, "page:desktop:x:retry");
	assert.equal(cleaned, 1);
	assert.deepEqual(pageIncomplete(page), []);
	assert.deepEqual(page.retried.problems, [
		"did not settle in 25 s (1 request(s) in flight: /lib.js)",
		"still showing the admin boot loader",
		"no main element",
		"no main h1 element",
	]);

	let calls = 0;
	const error = { status: 500, settle: { settled: true, ms: 100 }, content: readyState() };
	const failed = await measureScreen(
		async () => {
			calls++;
			return error;
		},
		{ phase: "p", beforeRetry: async () => {} },
	);
	assert.equal(calls, 1);
	assert.deepEqual(pageIncomplete(failed.page), ["document status 500"]);
});

const screen = (over = {}) => ({
	name: "admin list posts",
	viewport: "mobile",
	status: 200,
	settle: { settled: true, ms: 1000 },
	content: readyState(),
	cls: 0,
	api: { count: 6, polling: 0 },
	bytesByType: { Image: 0 },
	oversizedImages: [],
	lateDiscovered: [],
	...over,
});

const bootSpinner = screen({
	settle: { settled: true, ms: 3200 },
	content: readyState({ booting: true, found: false, heading: false }),
	api: { count: 2, polling: 0 },
});

void test("a screen whose capture is incomplete on either side is incomparable, not a regression or an improvement", () => {
	const before = [{ profile: "blog-node-sqlite", pages: [bootSpinner] }];
	const after = [{ profile: "blog-node-sqlite", pages: [screen()] }];
	const { rows, regressions } = compareResults(before, after, DEFAULT_THRESHOLDS);
	assert.equal(regressions.length, 0);
	const api = rows.find((r) => r.metric === "API requests");
	assert.deepEqual([api.before, api.after, api.regression], [2, 6, false]);
	assert.equal(
		api.incomparable,
		"before: still showing the admin boot loader; no main element; no main h1 element",
	);
	assert.ok(rows.every((r) => r.incomparable));

	const reversed = compareResults(after, before, DEFAULT_THRESHOLDS);
	assert.ok(reversed.rows.every((r) => r.incomparable?.startsWith("after: ")));

	const summary = renderSummary({
		name: "x",
		startedAt: "",
		options: { viewports: ["mobile"], dbLatency: 0, locale: "en", confirmSamples: 2 },
		workspace: { path: "/w" },
		distorting: [],
		profiles: [],
		budgetFailures: [],
		comparison: { ...compareResults(before, after, DEFAULT_THRESHOLDS), bundleDeltas: [] },
	});
	assert.match(summary, NOT_COMPARED);
	assert.match(summary, INCOMPARABLE_ROW);

	const complete = compareResults(
		[{ profile: "blog-node-sqlite", pages: [screen({ api: { count: 2, polling: 0 } })] }],
		after,
		DEFAULT_THRESHOLDS,
	);
	assert.equal(complete.regressions.length, 1);
});

void test("polls of a polling endpoint are counted apart from the screen's API requests and do not hold settling", () => {
	const cdp = new EventEmitter();
	const network = recordNetwork(cdp);
	const progress = "http://localhost/_emdash/api/admin/media-usage/progress";
	let id = 0;
	let ts = 1;
	const send = (url, method = "GET", type = "Fetch") => {
		const requestId = String(++id);
		cdp.emit("Network.requestWillBeSent", {
			requestId,
			type,
			timestamp: ts++,
			request: { url, method },
		});
		return requestId;
	};
	const finish = (requestId) =>
		cdp.emit("Network.loadingFinished", { requestId, timestamp: ts++, encodedDataLength: 100 });

	finish(send("http://localhost/_emdash/admin", "GET", "Document"));
	finish(send("http://localhost/_emdash/api/manifest"));
	finish(send(progress));
	finish(send(progress, "POST"));
	const poll = send(progress, "POST");
	send(progress);
	assert.equal(network.inflight, 0);
	assert.equal(network.pending.size, 0);
	finish(poll);

	const summary = summarizeRequests(normalizeRequests(network));
	assert.equal(summary.api.count, 3);
	assert.equal(summary.api.polling, 2);
	assert.deepEqual(
		summary.waterfall.filter((r) => r.poll).map((r) => r.method),
		["POST", "GET"],
	);

	const before = screen({ api: { count: 5, polling: 50 } });
	const after = screen({ api: { count: 5, polling: 85 } });
	const { rows, regressions } = compareResults(
		[{ profile: "p", pages: [before] }],
		[{ profile: "p", pages: [after] }],
		DEFAULT_THRESHOLDS,
	);
	assert.equal(regressions.length, 0);
	assert.deepEqual(
		rows.filter((r) => r.metric.startsWith("API")).map((r) => [r.metric, r.before, r.after]),
		[
			["API requests", 5, 5],
			["API polling requests", 50, 85],
		],
	);
});

const coldProfile = (publicSamples) => ({
	profile: "blog-workerd-d1",
	pages: [],
	coldStart: {
		publicPage: {
			path: "/",
			status: 200,
			ttfbMs: publicSamples.toSorted((a, b) => a - b)[1],
			samplesTtfbMs: publicSamples,
			samplesStatus: publicSamples.map(() => 200),
		},
	},
});

const restarts = (values) => ({
	publicPage: {
		ttfbMs: values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)],
		samplesTtfbMs: values,
		samplesStatus: values.map(() => 200),
	},
});

void test("cold-start confirmation takes the median of every raw restart from both passes", () => {
	const before = [coldProfile([100, 100, 100])];
	const after = [coldProfile([100, 200, 200])];
	const candidates = compareResults(before, after, DEFAULT_THRESHOLDS).regressions;
	assert.deepEqual(
		candidates.map((c) => [c.where, c.metric]),
		[["cold start", "publicPage ttfb ms"]],
	);
	const [judged] = confirmRegressions(
		candidates,
		before,
		after,
		{ "blog-workerd-d1": { coldStart: [restarts([100, 100])] } },
		{ "blog-workerd-d1": { coldStart: [restarts([100, 100])] } },
		DEFAULT_THRESHOLDS,
	);
	assert.deepEqual(
		pooledSamples(after[0], { coldStart: [restarts([100, 100])] }, judged),
		[100, 200, 200, 100, 100],
	);
	assert.equal(judged.medianAfter, 100);
	assert.equal(judged.confirmed, false);
	assert.deepEqual(judged.confirmation, {
		remeasured: true,
		statistic: "median",
		before: { n: 5, min: 100, max: 100 },
		after: { n: 5, min: 100, max: 200 },
	});
	assert.equal(describeConfirmation(judged), "median of 5 vs 5 samples; before 100, after 100-200");
});

const sample = (over) => ({
	valid: true,
	cls: 0,
	apiCount: 6,
	imageBytes: 0,
	oversized: 0,
	lateDiscovered: 1,
	...over,
});

void test("confirmation pools only complete captures, re-measures late imports, and labels what was not measured again", () => {
	const where = "mobile admin list posts";
	const before = [{ profile: "p", pages: [screen({ lateDiscovered: [1] })], scenarios: [] }];
	const after = [
		{
			profile: "p",
			pages: [screen({ cls: 0.05, lateDiscovered: [1, 2, 3] })],
			scenarios: [{ name: "editor typing (desktop)", keyToFrameP95Ms: 120 }],
		},
	];
	before[0].scenarios = [{ name: "editor typing (desktop)", keyToFrameP95Ms: 40 }];
	const candidates = compareResults(before, after, DEFAULT_THRESHOLDS).regressions;
	assert.deepEqual(
		candidates.map((c) => c.metric),
		["CLS", "late-discovered JS/CSS", "input-to-frame p95 ms"],
	);
	const judged = confirmRegressions(
		candidates,
		before,
		after,
		{ p: { pages: { [where]: [sample(), sample()] } } },
		{
			p: {
				pages: {
					[where]: [
						sample({ cls: 0.06, lateDiscovered: 1 }),
						sample({ valid: false, cls: 0, lateDiscovered: 0 }),
					],
				},
			},
		},
		DEFAULT_THRESHOLDS,
	);
	const [cls, late, typing] = judged;
	assert.equal(cls.confirmed, true);
	assert.deepEqual(cls.confirmation.after, { n: 2, min: 0.05, max: 0.06 });
	assert.equal(late.confirmation.remeasured, true);
	assert.equal(late.medianAfter, 2);
	assert.equal(late.confirmed, true);
	assert.deepEqual(typing.confirmation, { remeasured: false });
	assert.equal(describeConfirmation(typing), "first pass only, not measured again");
});
