/**
 * Budgets and before/after comparison over profile results.
 */

import { compositionDeltas } from "./bundle-composition.mjs";
import { pageIncomplete } from "./failures.mjs";

const KiB = 1024;
const FRAME_BUDGET_MS = 50;
const INPUT_TO_FRAME_PERCENT = 25;
const WRITE_TTFB_FLOOR_MS = 10;

export function serverGzipBytes(profile) {
	return profile.build?.upload?.uploadGzipBytes ?? profile.build?.server?.gzipBytes ?? null;
}

function oversizedCount(profile) {
	const unique = new Set();
	for (const page of profile.pages ?? []) {
		for (const img of page.oversizedImages ?? [])
			unique.add(`${page.viewport} ${page.url} ${img.src}`);
	}
	return unique.size;
}

/** Budget failures across all profiles. */
export function evaluateBudgets(profiles, budgets) {
	const failures = [];
	for (const p of profiles) {
		if (budgets.cls !== undefined) {
			for (const page of p.pages ?? []) {
				if (page.cls > budgets.cls) {
					failures.push({
						profile: p.profile,
						budget: "max-cls",
						limit: budgets.cls,
						actual: page.cls,
						where: `${page.viewport} ${page.name}`,
					});
				}
			}
			for (const s of p.scenarios ?? []) {
				if ((s.cls ?? 0) > budgets.cls) {
					failures.push({
						profile: p.profile,
						budget: "max-cls",
						limit: budgets.cls,
						actual: s.cls,
						where: `scenario ${s.name}`,
					});
				}
			}
		}
		const gz = serverGzipBytes(p);
		if (budgets.serverGzipKiB !== undefined && gz !== null && gz / KiB > budgets.serverGzipKiB) {
			failures.push({
				profile: p.profile,
				budget: "max-server-gz",
				limit: budgets.serverGzipKiB,
				actual: Math.round(gz / KiB),
				where: "server bundle",
			});
		}
		const upload = p.build?.upload?.uploadGzipBytes;
		if (
			budgets.uploadGzipKiB !== undefined &&
			upload != null &&
			upload / KiB > budgets.uploadGzipKiB
		) {
			failures.push({
				profile: p.profile,
				budget: "max-upload-gz",
				limit: budgets.uploadGzipKiB,
				actual: Math.round(upload / KiB),
				where: "worker upload",
			});
		}
		const js = p.initialAdminJs?.gzipBytes;
		if (
			budgets.initialJsGzipKiB !== undefined &&
			js !== undefined &&
			js / KiB > budgets.initialJsGzipKiB
		) {
			failures.push({
				profile: p.profile,
				budget: "max-initial-js-gz",
				limit: budgets.initialJsGzipKiB,
				actual: Math.round(js / KiB),
				where: "admin initial JS",
			});
		}
		const oversized = oversizedCount(p);
		if (budgets.oversizedImages !== undefined && oversized > budgets.oversizedImages) {
			failures.push({
				profile: p.profile,
				budget: "max-oversized-images",
				limit: budgets.oversizedImages,
				actual: oversized,
				where: "all screens",
			});
		}
	}
	return failures;
}

function imageBytes(page) {
	return page.bytesByType?.Image ?? 0;
}

function pct(before, after) {
	if (!before) return after ? Infinity : 0;
	return ((after - before) / before) * 100;
}

/**
 * Compare `after` (the workspace under test) against `before` (the
 * --compare workspace). Rows cover each page and the profile-level numbers;
 * a row is a regression when it crosses its threshold. When either side's
 * capture of a screen is incomplete, that screen's rows are marked
 * `incomparable` with the reason and are never regressions.
 */
export function compareResults(beforeProfiles, afterProfiles, thresholds) {
	const rows = [];
	for (const after of afterProfiles) {
		const before = beforeProfiles.find((p) => p.profile === after.profile);
		if (!before) continue;
		let incomparable = null;
		const add = (where, metric, b, a, regression) =>
			rows.push({
				profile: after.profile,
				where,
				metric,
				before: b,
				after: a,
				regression: incomparable ? false : regression,
				...(incomparable ? { incomparable } : {}),
			});

		const gzB = serverGzipBytes(before);
		const gzA = serverGzipBytes(after);
		if (gzB !== null && gzA !== null) {
			add("build", "server gzip bytes", gzB, gzA, pct(gzB, gzA) > thresholds.serverGzipPercent);
		}
		const jsB = before.initialAdminJs?.gzipBytes;
		const jsA = after.initialAdminJs?.gzipBytes;
		if (jsB !== undefined && jsA !== undefined) {
			add(
				"build",
				"admin initial JS gzip bytes",
				jsB,
				jsA,
				pct(jsB, jsA) > thresholds.serverGzipPercent,
			);
		}
		for (const key of ["publicPage", "adminApi"]) {
			const b = before.coldStart?.[key]?.ttfbMs;
			const a = after.coldStart?.[key]?.ttfbMs;
			if (b !== undefined && a !== undefined) {
				add("cold start", `${key} ttfb ms`, b, a, pct(b, a) > thresholds.coldStartPercent);
			}
		}
		for (const pageA of after.pages ?? []) {
			const pageB = (before.pages ?? []).find(
				(p) => p.name === pageA.name && p.viewport === pageA.viewport,
			);
			if (!pageB) continue;
			const where = `${pageA.viewport} ${pageA.name}`;
			const sides = [
				{ side: "before", problems: pageIncomplete(pageB) },
				{ side: "after", problems: pageIncomplete(pageA) },
			].filter((s) => s.problems.length > 0);
			incomparable =
				sides.length > 0
					? sides.map((s) => `${s.side}: ${s.problems.join("; ")}`).join(" | ")
					: null;
			add(where, "CLS", pageB.cls, pageA.cls, pageA.cls - pageB.cls > thresholds.cls);
			const gapB = pageB.api.scriptsToFirstApiMs;
			const gapA = pageA.api.scriptsToFirstApiMs;
			if (gapB != null && gapA != null) {
				add(where, "JS done to first API ms", gapB, gapA, false);
			}
			add(
				where,
				"API requests",
				pageB.api.count,
				pageA.api.count,
				pageA.api.count - pageB.api.count > thresholds.apiRequests,
			);
			if (pageA.api.polling || pageB.api.polling) {
				add(where, "API polling requests", pageB.api.polling ?? 0, pageA.api.polling ?? 0, false);
			}
			const ib = imageBytes(pageB);
			const ia = imageBytes(pageA);
			add(
				where,
				"image bytes",
				ib,
				ia,
				ia > 50 * KiB && pct(ib, ia) > thresholds.imageBytesPercent,
			);
			if (pageA.lateDiscovered && pageB.lateDiscovered) {
				add(
					where,
					"late-discovered JS/CSS",
					pageB.lateDiscovered.length,
					pageA.lateDiscovered.length,
					pageA.lateDiscovered.length > pageB.lateDiscovered.length,
				);
			}
			add(
				where,
				"oversized images",
				pageB.oversizedImages.length,
				pageA.oversizedImages.length,
				pageA.oversizedImages.length > pageB.oversizedImages.length,
			);
		}
		incomparable = null;
		for (const wA of after.writes ?? []) {
			const wB = (before.writes ?? []).find((w) => w.op === wA.op);
			if (!wB) continue;
			compareWrite(wB, wA, thresholds, (metric, b, a, regression) =>
				add(`write ${wA.op}`, metric, b, a, regression),
			);
		}
		for (const sA of after.scenarios ?? []) {
			const sB = (before.scenarios ?? []).find((s) => s.name === sA.name);
			if (!sB) continue;
			const where = `scenario ${sA.name}`;
			if (sA.cls !== undefined && sB.cls !== undefined) {
				add(where, "CLS", sB.cls, sA.cls, sA.cls - sB.cls > thresholds.cls);
			}
			const b = sB.keyToFrameP95Ms;
			const a = sA.keyToFrameP95Ms;
			if (typeof a === "number" && typeof b === "number") {
				add(where, "input-to-frame p95 ms", b, a, typingRegressed(sB, sA));
				const loadB = sB.machineLoad?.cpuBusyPercent;
				const loadA = sA.machineLoad?.cpuBusyPercent;
				if (typeof loadB === "number" && typeof loadA === "number") {
					rows.at(-1).note = `machine CPU busy ${loadB}% -> ${loadA}%`;
				}
			}
		}
	}
	return {
		rows,
		regressions: rows.filter((r) => r.regression),
		bundleDeltas: bundleDeltas(beforeProfiles, afterProfiles),
	};
}

/** Per profile and bundle, the packages that grew or shrank by 2 KiB or more. */
export function bundleDeltas(beforeProfiles, afterProfiles) {
	const out = [];
	for (const after of afterProfiles) {
		const before = beforeProfiles.find((p) => p.profile === after.profile);
		for (const bundle of ["adminInitialJs", "server"]) {
			const b = before?.bundleComposition?.[bundle];
			const a = after.bundleComposition?.[bundle];
			if (!b || !a) continue;
			const deltas = compositionDeltas(b, a);
			if (deltas.length > 0) out.push({ profile: after.profile, bundle, deltas });
		}
	}
	return out;
}

/**
 * Typing regressed when every run in this workspace has an input-to-frame
 * p95 over the frame budget and more than 25% above the other workspace's
 * best run. A single slow run is machine load, not the code.
 */
export function typingRegressed(before, after) {
	const best = before.keyToFrameP95Ms;
	if (typeof best !== "number") return false;
	const runs = (after.samples ?? [after])
		.map((s) => s.keyToFrameP95Ms)
		.filter((v) => typeof v === "number");
	return (
		runs.length > 0 &&
		runs.every((v) => v > FRAME_BUDGET_MS && pct(best, v) > INPUT_TO_FRAME_PERCENT)
	);
}

/**
 * Compare rows for one write: queries, DB waves, TTFB, and round trips after
 * the response. Moving work into `after()` is how a write gets faster, so
 * round trips after the response are only shown; what is flagged is a rise
 * in all of the write's round trips, during and after the response.
 */
export function compareWrite(before, after, thresholds, add) {
	add(
		"queries",
		before.queries,
		after.queries,
		after.queries - before.queries >= thresholds.writeQueries,
	);
	if (typeof before.dbWaves === "number" && typeof after.dbWaves === "number") {
		add(
			"DB waves",
			before.dbWaves,
			after.dbWaves,
			after.dbWaves - before.dbWaves >= thresholds.writeWaves,
		);
	}
	add(
		"TTFB ms",
		before.ttfbMs,
		after.ttfbMs,
		pct(before.ttfbMs, after.ttfbMs) > thresholds.writeTtfbPercent &&
			after.ttfbMs - before.ttfbMs > WRITE_TTFB_FLOOR_MS,
	);
	const tripsB = before.afterResponse?.roundTrips;
	const tripsA = after.afterResponse?.roundTrips;
	if (typeof tripsB === "number" && typeof tripsA === "number") {
		add("round trips after the response", tripsB, tripsA, false);
		if (typeof before.dbRoundTrips === "number" && typeof after.dbRoundTrips === "number") {
			const totalB = before.dbRoundTrips + tripsB;
			const totalA = after.dbRoundTrips + tripsA;
			add("total round trips", totalB, totalA, totalA - totalB >= thresholds.writeQueries);
		}
	}
}

const rowKey = (r) => `${r.profile}|${r.where}|${r.metric}`;

export function median(values) {
	const sorted = values.filter((v) => typeof v === "number").toSorted((a, b) => a - b);
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The numbers a re-measured screen is compared on, from one capture. */
export function pageSample(page) {
	return {
		valid: pageIncomplete(page).length === 0,
		cls: page.cls,
		apiCount: page.api.count,
		apiPolling: page.api.polling ?? 0,
		imageBytes: page.bytesByType?.Image ?? 0,
		oversized: page.oversizedImages.length,
		lateDiscovered: page.lateDiscovered?.length ?? null,
	};
}

const PAGE_METRICS = {
	CLS: (s) => s.cls,
	"API requests": (s) => s.apiCount,
	"image bytes": (s) => s.imageBytes,
	"oversized images": (s) => s.oversized,
	"late-discovered JS/CSS": (s) => s.lateDiscovered,
};

const WRITE_METRICS = {
	queries: (o) => o.queries,
	"DB waves": (o) => o.dbWaves,
	"TTFB ms": (o) => o.ttfbMs,
	"total round trips": (o) =>
		typeof o.dbRoundTrips === "number" && typeof o.afterResponse?.roundTrips === "number"
			? o.dbRoundTrips + o.afterResponse.roundTrips
			: null,
};

/** One cold-start measurement's raw restarts that got a response below 400. */
function coldSamples(sample) {
	if (!sample) return [];
	const values = sample.samplesTtfbMs ?? [sample.ttfbMs];
	const statuses = sample.samplesStatus ?? [sample.status];
	return values.filter((v, i) => typeof v === "number" && !(statuses[i] >= 400));
}

/**
 * Every raw sample of one comparison row's metric from one workspace: the
 * first pass and the re-measurements in `extra`, leaving out incomplete
 * screen captures. Null when the row's metric is not re-measured.
 */
export function pooledSamples(profile, extra, row) {
	if (row.where === "cold start") {
		const [key] = row.metric.split(" ");
		return [profile.coldStart?.[key], ...(extra?.coldStart ?? []).map((c) => c[key])].flatMap(
			coldSamples,
		);
	}
	if (row.where.startsWith("write ")) {
		const pick = WRITE_METRICS[row.metric];
		const op = row.where.slice("write ".length);
		if (!pick) return null;
		return [
			profile.writes?.find((w) => w.op === op),
			...(extra?.writes ?? []).map((ops) => ops.find((o) => o.op === op)),
		]
			.filter(Boolean)
			.map(pick)
			.filter((v) => typeof v === "number");
	}
	const pick = PAGE_METRICS[row.metric];
	const page = (profile.pages ?? []).find((p) => `${p.viewport} ${p.name}` === row.where);
	if (!pick || !page) return null;
	return [pageSample(page), ...(extra?.pages?.[row.where] ?? [])]
		.filter((s) => s.valid !== false)
		.map(pick)
		.filter((v) => typeof v === "number");
}

/**
 * A copy of `profile` whose re-measured screens, cold starts and writes
 * carry the median of all their raw samples (see `pooledSamples`).
 */
export function withSamples(profile, extra) {
	if (!extra) return profile;
	const mid = (row) => median(pooledSamples(profile, extra, row) ?? []);
	const pages = (profile.pages ?? []).map((page) => {
		const where = `${page.viewport} ${page.name}`;
		if (!(extra.pages?.[where]?.length > 0)) return page;
		const at = (metric) => mid({ where, metric });
		const late = at("late-discovered JS/CSS");
		return {
			...page,
			cls: at("CLS"),
			api: { ...page.api, count: at("API requests") },
			bytesByType: { ...page.bytesByType, Image: at("image bytes") },
			oversizedImages: Array.from({ length: Math.round(at("oversized images") ?? 0) }),
			...(late === null ? {} : { lateDiscovered: Array.from({ length: Math.round(late) }) }),
		};
	});
	let coldStart = profile.coldStart;
	if (coldStart && extra.coldStart?.length > 0) {
		coldStart = Object.fromEntries(
			Object.keys(coldStart).map((key) => [
				key,
				{ ...coldStart[key], ttfbMs: mid({ where: "cold start", metric: `${key} ttfb ms` }) },
			]),
		);
	}
	let writes = profile.writes;
	if (writes && extra.writes?.length > 0) {
		writes = writes.map((w) => {
			const at = (metric) => mid({ where: `write ${w.op}`, metric });
			const ops = [w, ...extra.writes.map((o) => o.find((x) => x.op === w.op)).filter(Boolean)];
			return {
				...w,
				queries: at("queries"),
				ttfbMs: at("TTFB ms"),
				...(typeof w.dbWaves === "number" ? { dbWaves: at("DB waves") } : {}),
				...(typeof w.dbRoundTrips === "number"
					? { dbRoundTrips: median(ops.map((o) => o.dbRoundTrips)) }
					: {}),
				...(w.afterResponse
					? {
							afterResponse: {
								...w.afterResponse,
								roundTrips: median(ops.map((o) => o.afterResponse?.roundTrips)),
							},
						}
					: {}),
			};
		});
	}
	return { ...profile, pages, coldStart, writes };
}

/** What to measure again for a set of candidate regressions, per profile. */
export function confirmationPlan(regressions) {
	const plan = new Map();
	for (const r of regressions) {
		const entry = plan.get(r.profile) ?? { pages: [], coldStart: false, writes: false };
		if (r.where === "cold start") entry.coldStart = true;
		else if (r.where.startsWith("write ")) entry.writes = true;
		else if (r.where !== "build" && !r.where.startsWith("scenario ")) {
			const [viewport, ...rest] = r.where.split(" ");
			const name = rest.join(" ");
			if (!entry.pages.some((p) => p.viewport === viewport && p.name === name)) {
				entry.pages.push({ viewport, name });
			}
		}
		plan.set(r.profile, entry);
	}
	return plan;
}

function spread(values) {
	return values.length === 0
		? null
		: { n: values.length, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Re-judge candidate regressions on the medians of pooled raw samples from
 * each workspace. A candidate stays a regression only when the median
 * comparison still crosses its threshold. Each candidate's `confirmation`
 * says how many samples each side pooled and their range; `remeasured` is
 * false when either side got no valid repeat sample (scenarios and build
 * output are never measured again), and then `confirmed` is the first-pass
 * judgement.
 */
export function confirmRegressions(candidates, before, after, extraBefore, extraAfter, thresholds) {
	const medianBefore = before.map((p) => withSamples(p, extraBefore[p.profile]));
	const medianAfter = after.map((p) => withSamples(p, extraAfter[p.profile]));
	const { rows } = compareResults(medianBefore, medianAfter, thresholds);
	const byKey = new Map(rows.map((r) => [rowKey(r), r]));
	return candidates.map((c) => {
		const pool = (profiles, extra) => {
			const p = profiles.find((x) => x.profile === c.profile);
			const all = p ? pooledSamples(p, extra[c.profile], c) : null;
			const firstPass = p ? pooledSamples(p, null, c) : null;
			return all && firstPass && all.length > firstPass.length ? all : null;
		};
		const b = pool(before, extraBefore);
		const a = pool(after, extraAfter);
		const remeasured = b !== null && a !== null;
		const m = remeasured ? byKey.get(rowKey(c)) : null;
		return {
			...c,
			medianBefore: m?.before ?? c.before,
			medianAfter: m?.after ?? c.after,
			confirmed: m ? m.regression : c.regression,
			confirmation: remeasured
				? { remeasured, statistic: "median", before: spread(b), after: spread(a) }
				: { remeasured },
		};
	});
}

function sameOriginPath(url, origin) {
	try {
		const parsed = new URL(url);
		return parsed.origin === origin ? parsed.pathname + parsed.search : null;
	} catch {
		return null;
	}
}

/**
 * Server errors (5xx) the profile's own requests got back, from page loads,
 * the server pass and cold starts, grouped by where and path. Workerd answers
 * a request it cancelled with a 500 and logs nothing, so these can be missing
 * from the server output.
 */
export function failedResponses(profile, origin) {
	const counts = new Map();
	const add = (where, path, status) => {
		if (!(status >= 500)) return;
		const key = `${where}\u0000${path}\u0000${status}`;
		const entry = counts.get(key) ?? { where, path, status, count: 0 };
		entry.count++;
		counts.set(key, entry);
	};
	for (const page of profile.pages ?? []) {
		const where = `${page.viewport} ${page.name}`;
		for (const r of page.waterfall ?? []) {
			const path = sameOriginPath(r.url, origin);
			if (path) add(where, path, r.status);
		}
		for (const r of page.serverPass ?? []) add(`${where} (server pass)`, r.path, r.status);
	}
	for (const sample of Object.values(profile.coldStart ?? {})) {
		add("cold start", sample.path, sample.status);
	}
	for (const w of profile.writes ?? []) add(`write ${w.op}`, w.path, w.status);
	return [...counts.values()];
}

/** Cold-start burst requests that did not get a 2xx or 3xx response. */
export function coldBurstFailures(profiles) {
	return profiles
		.filter((p) => p.coldBurst?.failedRequests > 0)
		.map((p) => ({
			profile: p.profile,
			failed: p.coldBurst.failedRequests,
			requests: p.coldBurst.requests,
			example: p.coldBurst.bursts.flatMap((b) => b.failed)[0],
		}));
}
