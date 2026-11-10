import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { initialJsBytes } from "./build-graph.mjs";
import { mergeDocuments } from "./documents.mjs";
import { contentWrites, writtenTables } from "./isolation.mjs";
import { computeCls, summarizeDbWait } from "./metrics.mjs";
import { captureGeometry, assertVisibleState } from "./visible-state.mjs";

const COLLECTOR = readFileSync(join(import.meta.dirname, "collector.js"), "utf8");

export const VIEWPORTS = {
	desktop: { viewport: { width: 1440, height: 900 } },
	mobile: {
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
		deviceScaleFactor: 2,
	},
};

export const NETWORK_PRESETS = {
	slow4g: {
		downloadThroughput: (1.6 * 1024 * 1024) / 8,
		uploadThroughput: (750 * 1024) / 8,
		latency: 150,
	},
	fast3g: {
		downloadThroughput: (1.44 * 1024 * 1024) / 8,
		uploadThroughput: (675 * 1024) / 8,
		latency: 562,
	},
};

const ARABIC_LANGUAGE = /lastresort|last resort/i;
const API_PREFIX = "/_emdash/api/";
const MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";
const QUIET_MS = 700;
const BEFORE_SHIFT_WINDOW_MS = 300;
const BEFORE_SHIFT_LIMIT = 8;
const NOT_FOUND_TEXT = /Page Not Found/;
const TRAILING_SLASH = /\/$/;
const ULID_IN_PATH = /[0-9A-HJKMNP-TV-Z]{26}/g;

const endpointKey = (method, url) => `${method} ${url.pathname.replaceAll(ULID_IN_PATH, ":id")}`;

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const gzipSizes = new Map();
async function gzipSize(response) {
	const url = response.url();
	if (!gzipSizes.has(url)) {
		gzipSizes.set(
			url,
			response
				.body()
				.then((body) => gzipSync(body).length)
				.catch(() => 0),
		);
	}
	return gzipSizes.get(url);
}

function queryBreakdown(events) {
	const repeats = new Map();
	const byRoute = {};
	const requests = new Map();
	for (const event of events) {
		const { sql, route, requestId } = event;
		repeats.set(`${route} ${sql}`, (repeats.get(`${route} ${sql}`) ?? 0) + 1);
		byRoute[route] = (byRoute[route] ?? 0) + 1;
		if (!requests.has(requestId)) requests.set(requestId, { route, events: [] });
		requests.get(requestId).events.push(event);
	}
	const repeated = [...repeats]
		.filter(([, count]) => count > 1)
		.toSorted(([, a], [, b]) => b - a)
		.slice(0, 5)
		.map(([query, count]) => ({ count, query: query.slice(0, 200) }));
	return { total: events.length, byRoute, repeated, ...summarizeDbWait([...requests.values()]) };
}

function attachBeforeEvents(shifts, timeline) {
	for (const shift of shifts) {
		shift.before = timeline
			.filter(
				(event) =>
					event.documentId === shift.documentId &&
					event.t <= shift.t + 16 &&
					event.t >= shift.t - BEFORE_SHIFT_WINDOW_MS,
			)
			.slice(-BEFORE_SHIFT_LIMIT)
			.map((event) => `${event.t - shift.t}ms ${event.kind}: ${event.detail}`);
	}
}

function stepSummaries(names, data, requests) {
	return names.map((name) => {
		const shifts = data.shifts.filter((shift) => shift.step === name);
		return {
			name,
			...computeCls(shifts),
			longTaskMs: data.longTasks
				.filter((task) => task.step === name)
				.reduce((sum, task) => sum + task.duration, 0),
			apiRequests: requests.filter((request) => request.step === name).length,
		};
	});
}

export async function runMeasurement({
	browser,
	site,
	options,
	target,
	viewportName,
	pass,
	outDir,
}) {
	const key = `${viewportName}:${target.id}`;
	const phase = `audit-${pass}-${viewportName}-${target.id}`;
	const context = await browser.newContext({
		...VIEWPORTS[viewportName],
		baseURL: site.baseUrl,
		locale: options.locale ?? "en",
		colorScheme: options.dark ? "dark" : "light",
		storageState: target.auth ? site.storageState : undefined,
		extraHTTPHeaders: { "x-perf-phase": phase },
	});
	await context.addCookies([
		{ name: "emdash-locale", value: options.locale ?? "en", url: `${site.baseUrl}/_emdash` },
	]);
	const documents = new Map();
	await context.exposeBinding("__auditDocument", ({ frame, page: sourcePage }, snapshot) => {
		if (frame === sourcePage.mainFrame()) documents.set(snapshot.documentId, snapshot);
	});
	await context.addInitScript((enabled) => {
		window.__auditReactProfile = enabled;
	}, options.reactProfile);
	await context.addInitScript(COLLECTOR);
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);

	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	await cdp.send("Performance.enable");
	if (options.locale?.split("-")[0] === "ar") {
		const families = execFileSync("fc-list", [":lang=ar", "family"], { encoding: "utf8" });
		if (!families.trim())
			throw new Error(
				"Arabic glyph preflight failed: install fonts-noto-core and fontconfig before auditing RTL.",
			);
		await cdp.send("DOM.enable");
		await cdp.send("CSS.enable");
		await page.setContent('<span id="arabic-probe" style="font:32px sans-serif">العربية</span>');
		const { root } = await cdp.send("DOM.getDocument");
		const { nodeId } = await cdp.send("DOM.querySelector", {
			nodeId: root.nodeId,
			selector: "#arabic-probe",
		});
		const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
		if (!fonts.some((font) => font.glyphCount > 0 && !ARABIC_LANGUAGE.test(font.familyName)))
			throw new Error(
				"Arabic glyph preflight failed: install an Arabic font (for example fonts-noto-core) before auditing RTL.",
			);
	}
	const transferByRequest = new Map();
	cdp.on("Network.responseReceived", ({ requestId, type }) => {
		transferByRequest.set(requestId, { type, bytes: 0 });
	});
	cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
		const entry = transferByRequest.get(requestId);
		if (entry) entry.bytes = encodedDataLength;
	});
	if (options.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpu });
	if (options.network) {
		await cdp.send("Network.emulateNetworkConditions", {
			offline: false,
			...NETWORK_PRESETS[options.network],
		});
	}

	let currentStep = "load";
	const stepNames = [];
	const inflight = new Set();
	const apiRequests = [];
	const consoleErrors = [];
	const gzipTasks = [];
	const failedRequests = [];

	page.on("request", (request) => {
		inflight.add(request);
		const url = new URL(request.url());
		if (url.pathname.startsWith(API_PREFIX) && !url.pathname.startsWith(MEDIA_FILE_PREFIX)) {
			apiRequests.push({
				method: request.method(),
				path: url.pathname + url.search,
				step: currentStep,
			});
		}
	});
	const apiTimings = [];
	let firstRequestAt;
	let lastApiEndMs = 0;
	let documentTiming;
	const finishRequest = (request) => inflight.delete(request);
	page.on("requestfailed", finishRequest);
	page.on("requestfinished", (request) => {
		finishRequest(request);
		const timing = request.timing();
		firstRequestAt ??= timing.startTime;
		const url = new URL(request.url());
		if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !documentTiming) {
			documentTiming = { ttfbMs: timing.responseStart, totalMs: timing.responseEnd };
		}
		if (url.pathname.startsWith(API_PREFIX) && !url.pathname.startsWith(MEDIA_FILE_PREFIX)) {
			apiTimings.push({ endpoint: endpointKey(request.method(), url), ms: timing.responseEnd });
			lastApiEndMs = Math.max(lastApiEndMs, timing.startTime + timing.responseEnd - firstRequestAt);
		}
	});
	page.on("response", (response) => {
		const type = response.request().resourceType();
		if (type === "script" || type === "stylesheet") {
			gzipTasks.push(gzipSize(response).then((bytes) => ({ type, bytes })));
		}
		const { origin, pathname } = new URL(response.url());
		const isApiError = response.status() >= 400 && pathname.startsWith(API_PREFIX);
		if (origin === site.baseUrl && (isApiError || response.status() >= 500)) {
			failedRequests.push(`${response.status()} ${pathname}`);
		}
	});
	page.on("console", (message) => {
		if (message.type() === "error" && consoleErrors.length < 5)
			consoleErrors.push(message.text().slice(0, 300));
	});
	page.on("pageerror", (error) => {
		if (consoleErrors.length < 5) consoleErrors.push(`pageerror: ${error.message.slice(0, 300)}`);
	});

	const heldRoutes = [];
	const interceptApi = options.slowApi > 0 || options.hold;
	if (interceptApi) {
		await context.route(`**${API_PREFIX}**`, async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname.startsWith(MEDIA_FILE_PREFIX)) return route.continue();
			if (options.hold && (url.pathname + url.search).includes(options.hold)) {
				heldRoutes.push(route);
				return undefined;
			}
			if (options.slowApi > 0) await sleep(options.slowApi);
			return route.continue();
		});
	}

	const maxSettleMs =
		10_000 + options.slowApi * 3 + (options.cpu > 1 ? 10_000 : 0) + (options.network ? 60_000 : 0);
	let settleTimeouts = 0;
	const settle = async () => {
		const deadline = Date.now() + maxSettleMs;
		while (Date.now() < deadline) {
			const held = new Set(heldRoutes.map((route) => route.request()));
			const pending = [...inflight].filter((request) => !held.has(request));
			if (pending.length === 0) {
				const idleFor = await page
					.evaluate(() => window.__perfAudit?.idleFor() ?? 0)
					.catch(() => 0);
				if (idleFor >= QUIET_MS) return;
			}
			await sleep(100);
		}
		settleTimeouts++;
	};
	const shot = async (suffix) => {
		const file = join(outDir, "shots", `${key.replaceAll(/[^a-z0-9-]+/gi, "_")}-${suffix}.png`);
		await page.screenshot({ path: file }).catch(() => {});
		return file;
	};
	const scriptSamples = [];
	const transitionSamples = [];
	const scriptTime = async () =>
		(await cdp.send("Performance.getMetrics")).metrics.find(
			(metric) => metric.name === "ScriptDuration",
		)?.value ?? 0;
	const typeKeys = async (locator, text) => {
		await locator.focus();
		for (const character of text) {
			const before = await scriptTime();
			await page.keyboard.type(character);
			await page.evaluate(
				() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
			);
			scriptSamples.push({
				step: currentStep,
				key: character,
				scriptMs: ((await scriptTime()) - before) * 1000,
			});
		}
	};
	const step = async (name, action) => {
		currentStep = name;
		stepNames.push(name);
		await page.evaluate((stepName) => window.__perfAudit?.mark(stepName), name).catch(() => {});
		const before = await scriptTime();
		const sampleStarted = performance.now();
		let sampleTask;
		const timer =
			options.midpointMs > 0
				? setTimeout(() => {
						sampleTask = (async () => {
							const geometry = await captureGeometry(page);
							const dialogs = await page
								.locator('[role="dialog"]')
								.evaluateAll((elements) =>
									elements.map((element) => element.getBoundingClientRect().toJSON()),
								);
							const screenshot = options.screenshots
								? await shot(`transition-${transitionSamples.length}`)
								: undefined;
							transitionSamples.push({
								step: name,
								elapsedMs: performance.now() - sampleStarted,
								geometry,
								dialogs,
								screenshot,
							});
						})().catch((sampleError) =>
							transitionSamples.push({
								step: name,
								elapsedMs: performance.now() - sampleStarted,
								error: String(sampleError),
							}),
						);
					}, options.midpointMs)
				: undefined;
		try {
			await action();
			await page.evaluate((stepName) => window.__perfAudit?.mark(stepName), name).catch(() => {});
			await settle();
			scriptSamples.push({ step: name, scriptMs: ((await scriptTime()) - before) * 1000 });
			const snapshot = await page.evaluate(() => window.__perfAudit?.snapshot()).catch(() => null);
			if (snapshot) documents.set(snapshot.documentId, snapshot);
		} finally {
			clearTimeout(timer);
			await Promise.resolve(sampleTask);
		}
	};

	let status = "ok";
	let httpStatus;
	const shots = {};
	let error;
	const startedAt = Date.now();
	try {
		if (target.kind === "route") {
			stepNames.push("load");
			const response = await page.goto(target.url, { waitUntil: "commit" });
			httpStatus = response?.status();
			if (options.hold) {
				await settle();
				shots.held = await shot("held");
				for (const route of heldRoutes.splice(0)) await route.continue().catch(() => {});
			}
			await settle();
			if (
				target.id === "public:/search?q=static" &&
				(await page.locator(".result-link").count()) === 0
			)
				throw new Error("Search fixture returned no results for known query static");
			if (options.screenshots) shots.final = await shot("final");
		} else {
			await target.run({
				page,
				step,
				typeKeys,
				captureGeometry: (geometryOptions) => captureGeometry(page, geometryOptions),
				assertVisibleState,
				baseUrl: site.baseUrl,
				viewportName,
				params: site.params,
			});
			if (options.screenshots) shots.final = await shot("final");
		}
	} catch (caught) {
		status = "error";
		error = caught instanceof Error ? caught.message.split("\n")[0].slice(0, 300) : String(caught);
		shots.failure = await shot("failure");
	}

	const finalDocument = await page
		.evaluate(() => window.__perfAudit?.snapshot() ?? null)
		.catch(() => null);
	if (finalDocument) documents.set(finalDocument.documentId, finalDocument);
	const data = mergeDocuments([...documents.values()]);
	const bodyText = await page
		.locator("body")
		.innerText({ timeout: 2000 })
		.catch(() => "");
	await Promise.allSettled(gzipTasks);
	const gzipped = await Promise.all(gzipTasks);
	await context.close();
	await sleep(120);
	const rawQueries = site.takeQueries(phase);
	if (options.queryTimeline)
		writeFileSync(
			join(outDir, `${key.replaceAll(/[^a-z0-9-]+/gi, "_")}-queries.json`),
			JSON.stringify(
				rawQueries.filter((event) => event.route.includes(options.queryTimeline)),
				null,
				2,
			),
		);
	const queries = queryBreakdown(rawQueries);
	const writes = contentWrites(rawQueries);
	const stateWrites = writes.length
		? { count: writes.length, tables: writtenTables(writes) }
		: undefined;

	if (!data) {
		return {
			key,
			id: target.id,
			fixtureOnly: target.fixtureOnly,
			kind: target.kind,
			viewport: viewportName,
			status: "error",
			error: error ?? "collector unavailable",
			stateWrites,
			metrics: null,
		};
	}

	attachBeforeEvents(data.shifts, data.timeline);

	const finalPath = data.finalPath;
	if (status === "ok" && target.kind === "route") {
		if (httpStatus && httpStatus >= 400) status = `http-${httpStatus}`;
		const expected = target.url.split("?")[0].replace(TRAILING_SLASH, "");
		const actual = finalPath.split("?")[0].replace(TRAILING_SLASH, "");
		if (status === "ok" && actual !== expected) status = `redirected:${actual}`;
		if (
			status === "ok" &&
			target.id.startsWith("admin:") &&
			NOT_FOUND_TEXT.test(bodyText.slice(0, 2000))
		) {
			status = "not-found";
		}
	}

	const { cls, clsAll, shiftCount, inputShiftCount } = computeCls(data.shifts);
	const lcp = data.largestPaints.at(-1) ?? null;
	const fcp = data.paints["first-contentful-paint"] ?? null;
	const tbt = [...documents.values()].reduce(
		(total, document) =>
			total +
			document.longTasks
				.filter(
					(task) =>
						document.paints["first-contentful-paint"] === undefined ||
						task.t >= document.paints["first-contentful-paint"],
				)
				.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
		0,
	);

	const requestCounts = new Map();
	for (const request of apiRequests) {
		const key_ = `${request.step} ${request.method} ${request.path}`;
		requestCounts.set(key_, (requestCounts.get(key_) ?? 0) + 1);
	}
	const duplicates = [...requestCounts]
		.filter(([, count]) => count > 1)
		.map(([request, count]) => ({ request, count }));

	let initialJsGzip;
	if (target.kind === "route") {
		const graph = JSON.parse(
			readFileSync(
				new URL(
					`../../fixtures/perf-site/.perf-audit/dist-${options.db}${options.plugins ? "-plugins" : ""}/client/perf-initial-js.json`,
					import.meta.url,
				),
				"utf8",
			),
		);
		initialJsGzip = initialJsBytes(graph, data.entryScripts);
	}
	const transfer = { js: 0, css: 0, image: 0, font: 0, other: 0, jsGzip: 0, cssGzip: 0 };
	for (const { type, bytes } of transferByRequest.values()) {
		const bucket =
			{ Script: "js", Stylesheet: "css", Image: "image", Font: "font" }[type] ?? "other";
		transfer[bucket] += bytes;
	}
	for (const { type, bytes } of gzipped) {
		transfer[type === "script" ? "jsGzip" : "cssGzip"] += bytes;
	}

	return {
		key,
		id: target.id,
		fixtureOnly: target.fixtureOnly,
		kind: target.kind,
		viewport: viewportName,
		url: target.url,
		pattern: target.pattern,
		status,
		error,
		settleTimeouts,
		stateWrites,
		durationMs: Date.now() - startedAt,
		processReadyMs: site.readyMs,
		metrics: {
			initialJsGzip,
			cls,
			clsAll,
			shiftCount,
			inputShiftCount,
			lcp: lcp?.t ?? null,
			lcpElement: lcp?.selector ?? null,
			fcp,
			tbt,
			longTasks: data.longTasks.length,
			apiRequests: apiRequests.length,
			duplicates,
			transfer,
			queries,
			documentTtfbMs: documentTiming?.ttfbMs ?? null,
			documentMs: documentTiming?.totalMs ?? null,
			lastApiEndMs: Math.round(lastApiEndMs),
		},
		apiTimings,
		scriptSamples,
		transitionSamples,
		documents: [...documents.values()],
		shifts: data.shifts,
		steps: stepSummaries(stepNames, data, apiRequests),
		failedRequests: failedRequests.slice(0, 10),
		consoleErrors,
		shots,
	};
}
