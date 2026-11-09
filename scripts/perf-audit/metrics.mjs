const SESSION_GAP_MS = 1000;
const SESSION_MAX_MS = 5000;

/** Largest session window, as defined for the Cumulative Layout Shift metric. */
function largestSessionWindow(shifts) {
	let largest = 0;
	let current = 0;
	let windowStart = 0;
	let previousTime = 0;
	for (const shift of shifts) {
		const startsNewWindow =
			current === 0 ||
			shift.t - previousTime >= SESSION_GAP_MS ||
			shift.t - windowStart >= SESSION_MAX_MS;
		if (startsNewWindow) {
			windowStart = shift.t;
			current = 0;
		}
		current += shift.value;
		previousTime = shift.t;
		largest = Math.max(largest, current);
	}
	return largest;
}

/**
 * `cls` follows the web-vitals definition, which ignores shifts within 500ms
 * of input. `clsAll` includes them, because a shift right after a click is
 * still visible; the audit reports both.
 */
export function computeCls(shifts) {
	const ordered = shifts.toSorted((a, b) => a.t - b.t);
	const afterInputFiltered = ordered.filter((shift) => !shift.hadRecentInput);
	return {
		cls: largestSessionWindow(afterInputFiltered),
		clsAll: largestSessionWindow(ordered),
		shiftCount: afterInputFiltered.length,
		inputShiftCount: ordered.length - afterInputFiltered.length,
	};
}

const OVERLAP_TOLERANCE_MS = 0.25;

/** Collapses one request's queries into sequential waves of overlapping queries. */
function requestWaves(events) {
	const ordered = events.toSorted((a, b) => a.startedAtMs - b.startedAtMs);
	let waves = 0;
	let waveEnd = Number.NEGATIVE_INFINITY;
	let waveStart = 0;
	let wallMs = 0;
	for (const { startedAtMs, durationMs } of ordered) {
		if (startedAtMs >= waveEnd - OVERLAP_TOLERANCE_MS) {
			if (waves > 0) wallMs += waveEnd - waveStart;
			waves++;
			waveStart = startedAtMs;
			waveEnd = startedAtMs;
		}
		waveEnd = Math.max(waveEnd, startedAtMs + durationMs);
	}
	if (waves > 0) wallMs += waveEnd - waveStart;
	return { waves, wallMs };
}

/**
 * For each HTTP request, `waves` counts queries that had to wait for a previous
 * one (each wave adds one network round trip), `queries` includes parallel
 * ones, and `wallMs` is the time at least one query was in flight.
 */
export function summarizeDbWait(requests) {
	let waves = 0;
	let queries = 0;
	let wallMs = 0;
	let sumMs = 0;
	const perEndpoint = {};
	const details = [];
	for (const { route, events } of requests) {
		const profile = requestWaves(events);
		const eventSum = events.reduce((sum, event) => sum + event.durationMs, 0);
		waves += profile.waves;
		queries += events.length;
		wallMs += profile.wallMs;
		sumMs += eventSum;
		const endpoint = route.replaceAll(/[0-9A-HJKMNP-TV-Z]{26}/g, ":id");
		const entry = (perEndpoint[endpoint] ??= { requests: 0, queries: 0, waves: 0 });
		entry.requests++;
		entry.queries += events.length;
		entry.waves += profile.waves;
		details.push({
			route: endpoint,
			queries: events.length,
			waves: profile.waves,
			wallMs: Math.round(profile.wallMs),
		});
	}
	return {
		waves,
		parallelism: waves ? queries / waves : 0,
		dbWallMs: Math.round(wallMs),
		dbSumMs: Math.round(sumMs),
		perEndpoint,
		worstRequests: details.toSorted((a, b) => b.wallMs - a.wallMs).slice(0, 5),
	};
}
