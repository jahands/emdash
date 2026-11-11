/**
 * Open one page in a fresh browser context and record what it cost.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { measurePixels } from "./image-pixels.mjs";
import {
	auditImages,
	computeCls,
	imageStates,
	computeTbt,
	isApiRequest,
	parseServerTiming,
	summarizeRequests,
} from "./metrics.mjs";
import { collectProbe, installProbe } from "./probe.mjs";
import { sleep } from "./proc.mjs";
import { installResizeEmulation } from "./resize-emulation.mjs";

export const VIEWPORTS = {
	desktop: { width: 1440, height: 900, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
	mobile: { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

export const NETWORK_PRESETS = {
	slow4g: {
		label: "slow4g (150 ms RTT, 1.6 Mbps down, 750 kbps up)",
		latency: 150,
		downloadThroughput: (1.6 * 1024 * 1024) / 8,
		uploadThroughput: (750 * 1024) / 8,
	},
};

function initiatorUrl(initiator) {
	if (!initiator) return null;
	if (initiator.url) return initiator.url;
	for (let stack = initiator.stack; stack; stack = stack.parent) {
		const frame = stack.callFrames?.find((f) => f.url);
		if (frame) return frame.url;
	}
	return null;
}

/**
 * A browser context set up the way every measurement needs: viewport,
 * locale, color scheme, session cookies, the query-log phase header,
 * throttling and the debugging routes.
 */
export async function openContext(browser, { site, viewport, cookies, options, phase, stats }) {
	const vp = VIEWPORTS[viewport];
	const context = await browser.newContext({
		viewport: { width: vp.width, height: vp.height },
		deviceScaleFactor: vp.deviceScaleFactor,
		isMobile: vp.isMobile,
		hasTouch: vp.hasTouch,
		locale: options.locale === "ar" ? "ar" : "en-US",
		colorScheme: options.dark ? "dark" : "light",
		extraHTTPHeaders: { "x-perf-phase": phase },
	});
	if (cookies) await context.addCookies(cookies);
	if (site.profile.images === "url") {
		await installResizeEmulation(context, site.origin, stats.resize);
	}
	if (options.slowApi > 0) {
		await context.route(`${site.origin}/_emdash/api/**`, async (route) => {
			await sleep(options.slowApi);
			await route.fallback();
		});
	}
	return context;
}

async function applyThrottling(cdp, options) {
	if (options.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpu });
	const preset = options.network ? NETWORK_PRESETS[options.network] : null;
	if (preset) {
		await cdp.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: preset.latency,
			downloadThroughput: preset.downloadThroughput,
			uploadThroughput: preset.uploadThroughput,
		});
	}
}

/** Record every request the page makes through the DevTools protocol. */
export function recordNetwork(cdp) {
	const byId = new Map();
	const state = { navStart: null, inflight: 0, lastActivity: Date.now(), requests: [] };
	cdp.on("Network.requestWillBeSent", (e) => {
		if (e.redirectResponse && byId.has(e.requestId)) {
			const prev = byId.get(e.requestId);
			prev.end = e.timestamp;
			prev.status = e.redirectResponse.status;
			byId.delete(e.requestId);
			state.inflight--;
		}
		if (state.navStart === null && e.type === "Document") state.navStart = e.timestamp;
		const record = {
			id: e.requestId,
			url: e.request.url,
			method: e.request.method,
			type: e.type ?? "Other",
			startTs: e.timestamp,
			endTs: null,
			status: null,
			bytes: 0,
			initiatorUrl: initiatorUrl(e.initiator),
			failed: false,
			serverTiming: null,
			fromCache: false,
		};
		byId.set(e.requestId, record);
		state.requests.push(record);
		state.inflight++;
		state.lastActivity = Date.now();
	});
	cdp.on("Network.requestServedFromCache", (e) => {
		const r = byId.get(e.requestId);
		if (r) r.fromCache = true;
	});
	cdp.on("Network.responseReceived", (e) => {
		const r = byId.get(e.requestId);
		if (!r) return;
		r.status = e.response.status;
		r.mimeType = e.response.mimeType;
		const headers = Object.fromEntries(
			Object.entries(e.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		r.serverTiming = parseServerTiming(headers["server-timing"]);
		r.emulated = headers["x-perf-audit-emulated"] ?? null;
		state.lastActivity = Date.now();
	});
	const finish = (e, failed) => {
		const r = byId.get(e.requestId);
		if (!r) return;
		r.endTs = e.timestamp;
		r.bytes = e.encodedDataLength ?? r.bytes;
		r.failed = failed;
		if (failed) r.errorText = e.errorText;
		byId.delete(e.requestId);
		state.inflight--;
		state.lastActivity = Date.now();
	};
	cdp.on("Network.loadingFinished", (e) => finish(e, false));
	cdp.on("Network.loadingFailed", (e) => finish(e, true));
	return state;
}

export function normalizeRequests(state) {
	const base = state.navStart ?? state.requests[0]?.startTs ?? 0;
	return state.requests.map((r) => ({
		url: r.url,
		method: r.method,
		type: r.type,
		start: (r.startTs - base) * 1000,
		end: r.endTs === null ? null : (r.endTs - base) * 1000,
		status: r.status,
		bytes: r.bytes,
		initiatorUrl: r.initiatorUrl,
		failed: r.failed,
		errorText: r.errorText,
		dbCount: r.serverTiming?.["db.count"] ?? null,
		emulated: r.emulated ?? null,
		fromCache: r.fromCache,
	}));
}

/** Wait until the network is quiet and nothing has shifted for `quietMs`. */
export async function waitForSettle(page, network, { quietMs = 1000, maxMs = 25_000 } = {}) {
	const started = Date.now();
	while (Date.now() - started < maxMs) {
		await sleep(100);
		if (network.inflight > 0 || Date.now() - network.lastActivity < quietMs) continue;
		const sinceShift = await page
			.evaluate(() => {
				const last = window.__perfProbe?.shifts.at(-1);
				return last ? performance.now() - last.startTime : Infinity;
			})
			.catch(() => Infinity);
		if (sinceShift >= quietMs) return { settled: true, ms: Date.now() - started };
	}
	return { settled: false, ms: Date.now() - started };
}

/**
 * Hold requests whose URL contains `substring` until a screenshot of the
 * loading state is taken, then release them.
 */
async function installHold(context, page, substring, screenshotPath, notes) {
	const held = [];
	let done = false;
	await context.route(
		(url) => !done && url.toString().includes(substring),
		async (route) => {
			if (done) return route.fallback();
			held.push(route);
			if (held.length === 1) {
				await sleep(1500);
				mkdirSync(dirname(screenshotPath), { recursive: true });
				await page.screenshot({ path: screenshotPath }).catch(() => {});
				notes.push(`held ${substring} and saved ${screenshotPath}`);
				done = true;
				for (const r of held.splice(0)) await r.fallback();
			}
		},
	);
}

export async function measurePage({
	browser,
	site,
	target,
	viewport,
	cookies,
	options,
	paths,
	phase,
	pixelCache = new Map(),
}) {
	const stats = { resize: {} };
	const context = await openContext(browser, { site, viewport, cookies, options, phase, stats });
	const notes = [];
	try {
		await context.addInitScript(installProbe);
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("Network.enable");
		await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
		await applyThrottling(cdp, options);
		const network = recordNetwork(cdp);
		if (options.hold) await installHold(context, page, options.hold, paths.hold, notes);

		const consoleErrors = [];
		page.on("pageerror", (err) => consoleErrors.push(String(err).slice(0, 300)));
		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
		});

		const url = `${site.origin}${target.path}`;
		const response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
		const throttled = options.network || options.cpu > 1 || options.slowApi > 0 || options.hold;
		const settle = await waitForSettle(page, network, { maxMs: throttled ? 180_000 : 25_000 });
		const probe = await page.evaluate(collectProbe);
		if (options.screenshots) {
			mkdirSync(dirname(paths.screenshot), { recursive: true });
			await page.screenshot({ path: paths.screenshot });
		}
		const finalUrl = page.url();

		const requests = normalizeRequests(network);
		const summary = summarizeRequests(requests);
		const bytesForUrl = (src) => {
			const match = requests.findLast((r) => r.url === src && r.bytes > 0);
			return match ? match.bytes : null;
		};
		const requestFailed = (src) =>
			requests.some((r) => r.url === src && (r.failed || (r.status ?? 0) >= 400));
		const loaded = probe.images.filter((img) => img.complete && img.naturalWidth > 0);
		const pixels = await measurePixels(
			context,
			loaded.map((img) => img.src),
			{ cache: pixelCache, emulated: stats.resize.outputs, phase },
		);
		const images = auditImages(probe.images, probe.dpr, {
			bytesForUrl,
			requestFailed,
			pixelsForUrl: (src) => pixels.get(src) ?? null,
		}).map((img) => ({
			...img,
			emulated: requests.find((r) => r.url === img.src)?.emulated ?? null,
		}));
		const fcp = probe.paints.find((p) => p.name === "first-contentful-paint")?.startTime ?? null;
		const lcp = probe.lcp.at(-1) ?? null;
		const cls = computeCls(probe.shifts);
		const doc = requests.find((r) => r.type === "Document");
		return {
			url: target.path,
			finalUrl: finalUrl.replace(site.origin, ""),
			status: response?.status() ?? null,
			redirected: finalUrl.replace(site.origin, "") !== target.path,
			settle,
			cls: Math.round(cls.value * 10000) / 10000,
			clsAttribution: cls.attribution.slice(0, 5),
			lcpMs: lcp ? Math.round(lcp.startTime) : null,
			lcpElement: lcp?.element ?? null,
			lcpUrl: lcp?.url || null,
			fcpMs: fcp === null ? null : Math.round(fcp),
			tbtMs: Math.round(computeTbt(probe.longTasks, fcp)),
			longTasks: probe.longTasks.length,
			documentMs: doc?.end === null || !doc ? null : Math.round(doc.end),
			documentDbCount: doc?.dbCount ?? null,
			api: summary.api,
			apiDbCount: requests
				.filter((r) => isApiRequest(r.url))
				.reduce((sum, r) => sum + (r.dbCount ?? 0), 0),
			requestCount: summary.requestCount,
			transferBytes: summary.totalBytes,
			bytesByType: summary.bytesByType,
			criticalChain: summary.criticalChain,
			maxDepth: summary.maxDepth,
			waterfall: summary.waterfall,
			images,
			imageStates: imageStates(images),
			oversizedImages: images.filter((img) => img.oversized),
			resizeEmulation:
				site.profile.images === "url"
					? {
							served: stats.resize.served,
							failed: stats.resize.failed,
							revalidated: stats.resize.revalidated,
							ignoredOptions: stats.resize.ignoredOptions,
						}
					: undefined,
			consoleErrors: consoleErrors.slice(0, 10),
			notes,
		};
	} finally {
		await context.close();
	}
}
