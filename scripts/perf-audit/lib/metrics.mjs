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
 * Flag images whose natural size is more than twice what the viewport
 * needs (rendered size times device pixel ratio) and that cost more than
 * 50 KB on the wire.
 */
export function auditImages(images, dpr, bytesForUrl) {
	return images.map((img) => {
		const neededWidth = Math.max(1, Math.ceil(img.renderedWidth * dpr));
		const neededHeight = Math.max(1, Math.ceil(img.renderedHeight * dpr));
		const factor = Math.max(img.naturalWidth / neededWidth, img.naturalHeight / neededHeight);
		const bytes = bytesForUrl(img.src);
		const oversized =
			factor > OVERSIZE_FACTOR &&
			bytes !== null &&
			bytes !== undefined &&
			bytes > OVERSIZE_MIN_BYTES;
		return {
			src: img.src,
			natural: `${img.naturalWidth}x${img.naturalHeight}`,
			needed: `${neededWidth}x${neededHeight}`,
			factor: Math.round(factor * 10) / 10,
			bytes: bytes ?? null,
			oversized,
		};
	});
}

export function isApiRequest(url) {
	try {
		return new URL(url).pathname.startsWith("/_emdash/api/");
	} catch {
		return false;
	}
}

/**
 * Summarize recorded requests. Times are milliseconds from navigation
 * start. `waitedOn` links each request to the one it depended on: its
 * parser or script initiator, or for an API call the API response that
 * finished just before it was issued by the same script.
 */
export function summarizeRequests(requests) {
	const byUrl = new Map();
	for (const r of requests) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
	const api = requests.filter((r) => isApiRequest(r.url));
	const sortedApi = api.toSorted((a, b) => a.start - b.start);

	const withDeps = requests.map((r) => {
		let waitedOn = r.initiatorUrl && byUrl.get(r.initiatorUrl) !== r ? r.initiatorUrl : null;
		if (isApiRequest(r.url)) {
			const gate = sortedApi.findLast(
				(q) => q !== r && q.end !== null && q.end <= r.start && r.start - q.end < 60,
			);
			if (gate) waitedOn = gate.url;
		}
		return { ...r, waitedOn };
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
	for (const r of requests) {
		const type = r.type ?? "Other";
		bytesByType[type] = (bytesByType[type] ?? 0) + (r.bytes ?? 0);
		totalBytes += r.bytes ?? 0;
	}

	const apiIntervals = api
		.filter((r) => r.end !== null)
		.map((r) => ({ start: r.start, end: r.end }));
	const lastApi = api.filter((r) => r.end !== null).toSorted((a, b) => b.end - a.end)[0];
	const chain = [];
	for (let r = lastApi && withDeps.find((q) => q.url === lastApi.url); r;) {
		chain.unshift(r.url);
		const next = r.waitedOn ? withDeps.find((q) => q.url === r.waitedOn) : null;
		if (!next || chain.includes(next.url)) break;
		r = next;
	}

	return {
		requestCount: requests.length,
		totalBytes,
		bytesByType,
		api: {
			count: api.length,
			bytes: api.reduce((sum, r) => sum + (r.bytes ?? 0), 0),
			lastResponseMs: lastApi ? Math.round(lastApi.end) : null,
			waves: computeWaves(apiIntervals, { toleranceMs: 2 }).waves,
			failed: api.filter((r) => r.failed || (r.status ?? 0) >= 400).length,
		},
		criticalChain: chain,
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
				waitedOn: r.waitedOn,
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
