/**
 * Pure calculations over what a page load recorded.
 */

import { computeWaves } from "./waves.mjs";

const SESSION_GAP_MS = 1000;
const SESSION_MAX_MS = 5000;

/**
 * Cumulative Layout Shift as Chrome defines it: shifts without recent input
 * grouped into session windows (gap under 1 s, window under 5 s); the score
 * is the largest window. Returns the worst window's shifts for attribution.
 */
export function computeCls(shifts) {
	const counted = shifts
		.filter((s) => !s.hadRecentInput)
		.toSorted((a, b) => a.startTime - b.startTime);
	let best = { value: 0, shifts: [] };
	let current = null;
	for (const shift of counted) {
		const startsNew =
			!current ||
			shift.startTime - current.last > SESSION_GAP_MS ||
			shift.startTime - current.first > SESSION_MAX_MS;
		if (startsNew)
			current = { first: shift.startTime, last: shift.startTime, value: 0, shifts: [] };
		current.last = shift.startTime;
		current.value += shift.value;
		current.shifts.push(shift);
		if (current.value > best.value) best = { value: current.value, shifts: [...current.shifts] };
	}
	return {
		value: best.value,
		windowStart: best.shifts[0]?.startTime ?? null,
		attribution: best.shifts
			.toSorted((a, b) => b.value - a.value)
			.map((s) => ({
				value: s.value,
				at: Math.round(s.startTime),
				sources: s.sources.map((src) => ({
					node: src.node,
					from: src.previousRect,
					to: src.currentRect,
					moved: src.previousRect &&
						src.currentRect && {
							dx: Math.round(src.currentRect.x - src.previousRect.x),
							dy: Math.round(src.currentRect.y - src.previousRect.y),
							dh: Math.round(src.currentRect.height - src.previousRect.height),
						},
				})),
			})),
	};
}

/** Total Blocking Time between first contentful paint and `endMs`. */
export function computeTbt(longTasks, fcpMs, endMs = Infinity) {
	const start = fcpMs ?? 0;
	let total = 0;
	for (const task of longTasks) {
		const taskEnd = task.startTime + task.duration;
		if (taskEnd <= start || task.startTime >= endMs) continue;
		const from = Math.max(task.startTime, start);
		const to = Math.min(taskEnd, endMs);
		const blocking = to - from - 50;
		if (blocking > 0) total += blocking;
	}
	return total;
}

export const OVERSIZE_FACTOR = 2;
export const OVERSIZE_MIN_BYTES = 50 * 1024;

/**
 * How far an image's pixels exceed what its box needs: rendered size times
 * device pixel ratio. `object-fit: cover` crops the longer side, so only the
 * smaller ratio is resolution the screen can show.
 */
export function oversizeFactor(pixels, { renderedWidth, renderedHeight, objectFit }, dpr) {
	const neededWidth = Math.max(1, Math.ceil(renderedWidth * dpr));
	const neededHeight = Math.max(1, Math.ceil(renderedHeight * dpr));
	const fx = pixels.width / neededWidth;
	const fy = pixels.height / neededHeight;
	return {
		neededWidth,
		neededHeight,
		factor: objectFit === "cover" ? Math.min(fx, fy) : Math.max(fx, fy),
	};
}

/**
 * Where an image stands after the page settled: `painted` in the viewport,
 * loaded but `offscreen` (or hidden), `failed`, or `not-loaded` (lazy or
 * still pending).
 */
export function imageState(img, requestFailed = false) {
	if (requestFailed) return "failed";
	if (img.complete && img.naturalWidth === 0) return img.src ? "failed" : "not-loaded";
	if (!img.complete) return "not-loaded";
	return img.visible ? "painted" : "offscreen";
}

/**
 * Audit every image on the page. Oversize is judged on the decoded image's
 * real pixels (`pixelsForUrl`); `naturalWidth` is density-corrected for
 * `srcset` width descriptors, so it is only the fallback. Painted images are
 * flagged when the excess is over 2x and they cost more than 50 KiB.
 */
export function auditImages(
	images,
	dpr,
	{ bytesForUrl, pixelsForUrl = () => null, requestFailed = () => false },
) {
	return images.map((img) => {
		const state = imageState(img, requestFailed(img.src));
		const bytes = bytesForUrl(img.src) ?? null;
		const decoded = state === "painted" || state === "offscreen" ? pixelsForUrl(img.src) : null;
		const pixels = decoded ?? { width: img.naturalWidth, height: img.naturalHeight };
		const out = {
			src: img.src,
			state,
			pixels: `${pixels.width}x${pixels.height}`,
			pixelsFrom: decoded ? decoded.from : "naturalWidth",
			natural: `${img.naturalWidth}x${img.naturalHeight}`,
			rendered: `${Math.round(img.renderedWidth)}x${Math.round(img.renderedHeight)}`,
			bytes,
			loading: img.loading ?? null,
			fetchPriority: img.fetchPriority ?? null,
			sizes: img.sizes || null,
			srcset: Boolean(img.srcset),
			oversized: false,
		};
		if (state !== "painted" && state !== "offscreen") return out;
		if (img.renderedWidth <= 0 || img.renderedHeight <= 0) return out;
		const { neededWidth, neededHeight, factor } = oversizeFactor(pixels, img, dpr);
		out.needed = `${neededWidth}x${neededHeight}`;
		out.factor = Math.round(factor * 10) / 10;
		out.oversized =
			state === "painted" &&
			factor > OVERSIZE_FACTOR &&
			bytes !== null &&
			bytes > OVERSIZE_MIN_BYTES;
		return out;
	});
}

/** Counts of images by state. */
export function imageStates(audited) {
	const counts = { painted: 0, offscreen: 0, failed: 0, "not-loaded": 0 };
	for (const img of audited) counts[img.state] = (counts[img.state] ?? 0) + 1;
	return counts;
}

export function isApiRequest(url) {
	try {
		return new URL(url).pathname.startsWith("/_emdash/api/");
	} catch {
		return false;
	}
}

/** Whether a CDN or compressing server would encode a response of this MIME type. */
export function isCompressibleMime(mime) {
	if (!mime) return false;
	const type = mime.split(";")[0].trim().toLowerCase();
	if (type === "text/event-stream") return false;
	return (
		type.startsWith("text/") ||
		type.endsWith("+json") ||
		type.endsWith("+xml") ||
		["application/javascript", "application/json", "application/xml", "application/wasm"].includes(
			type,
		)
	);
}

/**
 * Summarize recorded requests. Times are milliseconds from navigation
 * start. `waitedOn` links each request to the one it depended on, and
 * `waitedOnSource` says how that link is known:
 *
 * - `initiator-request`: Chromium named the request that triggered it.
 * - `initiator`: Chromium named the document or script that issued it.
 * - `inferred-timing`: an API call issued within 60 ms of another API
 *   response finishing. Chromium does not record which response a script
 *   awaited, so this is a guess; hold the request to prove it.
 */
export function summarizeRequests(requests) {
	const byUrl = new Map();
	for (const r of requests) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
	const api = requests.filter((r) => isApiRequest(r.url));
	const sortedApi = api.toSorted((a, b) => a.start - b.start);

	const withDeps = requests.map((r) => {
		let waitedOn = null;
		let waitedOnSource = null;
		if (r.initiatorRequestUrl && byUrl.get(r.initiatorRequestUrl) !== r) {
			waitedOn = r.initiatorRequestUrl;
			waitedOnSource = "initiator-request";
		} else if (r.initiatorUrl && byUrl.get(r.initiatorUrl) !== r) {
			waitedOn = r.initiatorUrl;
			waitedOnSource = "initiator";
		}
		if (isApiRequest(r.url) && waitedOnSource !== "initiator-request") {
			const gate = sortedApi.findLast(
				(q) => q !== r && q.end !== null && q.end <= r.start && r.start - q.end < 60,
			);
			if (gate) {
				waitedOn = gate.url;
				waitedOnSource = "inferred-timing";
			}
		}
		return { ...r, waitedOn, waitedOnSource };
	});

	const depth = new Map();
	const depthOf = (r, seen = new Set()) => {
		if (depth.has(r)) return depth.get(r);
		if (seen.has(r)) return 1;
		seen.add(r);
		const parent = r.waitedOn ? withDeps.find((q) => q.url === r.waitedOn) : null;
		const d = parent ? depthOf(parent, seen) + 1 : 1;
		depth.set(r, d);
		return d;
	};
	for (const r of withDeps) depthOf(r);

	const bytesByType = {};
	let totalBytes = 0;
	let compressedBytes = 0;
	for (const r of requests) {
		const type = r.type ?? "Other";
		bytesByType[type] = (bytesByType[type] ?? 0) + (r.bytes ?? 0);
		totalBytes += r.bytes ?? 0;
		compressedBytes += r.compressedBytes ?? r.bytes ?? 0;
	}

	const apiIntervals = api
		.filter((r) => r.end !== null)
		.map((r) => ({ start: r.start, end: r.end }));
	const lastApi = api.filter((r) => r.end !== null).toSorted((a, b) => b.end - a.end)[0];
	const firstApi = sortedApi[0];
	const scriptEnds = requests
		.filter((r) => r.type === "Script" && r.end !== null && firstApi && r.start < firstApi.start)
		.map((r) => r.end);
	const scriptsDone = scriptEnds.length > 0 ? Math.max(...scriptEnds) : null;
	const chain = [];
	for (let r = lastApi && withDeps.find((q) => q.url === lastApi.url); r;) {
		chain.unshift({ url: r.url, via: r.waitedOnSource });
		const next = r.waitedOn ? withDeps.find((q) => q.url === r.waitedOn) : null;
		if (!next || chain.some((c) => c.url === next.url)) break;
		r = next;
	}

	return {
		requestCount: requests.length,
		totalBytes,
		compressedBytes,
		bytesByType,
		api: {
			count: api.length,
			bytes: api.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
			lastResponseMs: lastApi ? Math.round(lastApi.end) : null,
			firstRequestMs: firstApi ? Math.round(firstApi.start) : null,
			scriptsDoneMs: scriptsDone === null ? null : Math.round(scriptsDone),
			scriptsToFirstApiMs: scriptsDone === null ? null : Math.round(firstApi.start - scriptsDone),
			waves: computeWaves(apiIntervals, { toleranceMs: 2 }).waves,
			failed: api.filter((r) => r.failed || (r.status ?? 0) >= 400).length,
		},
		criticalChain: chain,
		inferredLinks: withDeps.filter((r) => r.waitedOnSource === "inferred-timing").length,
		maxDepth: Math.max(0, ...depth.values()),
		waterfall: withDeps
			.toSorted((a, b) => a.start - b.start)
			.map((r) => ({
				url: r.url,
				method: r.method,
				type: r.type,
				status: r.status,
				start: Math.round(r.start),
				end: r.end === null ? null : Math.round(r.end),
				bytes: r.bytes,
				initiator: r.initiatorType ? { type: r.initiatorType, url: r.initiatorUrl ?? null } : null,
				waitedOn: r.waitedOn,
				waitedOnSource: r.waitedOnSource,
				depth: depth.get(r),
				dbCount: r.dbCount ?? null,
			})),
	};
}

/** Parse a Server-Timing header into { name: dur }. */
export function parseServerTiming(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(",")) {
		const [name, ...params] = part.trim().split(";");
		const dur = params.map((p) => p.trim()).find((p) => p.startsWith("dur="));
		if (name) out[name.trim()] = dur ? Number(dur.slice(4)) : null;
	}
	return out;
}
