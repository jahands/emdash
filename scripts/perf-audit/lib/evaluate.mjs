/**
 * Budgets and before/after comparison over profile results.
 */

const KiB = 1024;
const FRAME_BUDGET_MS = 50;
const INPUT_TO_FRAME_PERCENT = 25;

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
 * a row is a regression when it crosses its threshold.
 */
export function compareResults(beforeProfiles, afterProfiles, thresholds) {
	const rows = [];
	for (const after of afterProfiles) {
		const before = beforeProfiles.find((p) => p.profile === after.profile);
		if (!before) continue;
		const add = (where, metric, b, a, regression) =>
			rows.push({ profile: after.profile, where, metric, before: b, after: a, regression });

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
			add(where, "CLS", pageB.cls, pageA.cls, pageA.cls - pageB.cls > thresholds.cls);
			add(
				where,
				"API requests",
				pageB.api.count,
				pageA.api.count,
				pageA.api.count - pageB.api.count > thresholds.apiRequests,
			);
			const ib = imageBytes(pageB);
			const ia = imageBytes(pageA);
			add(
				where,
				"image bytes",
				ib,
				ia,
				ia > 50 * KiB && pct(ib, ia) > thresholds.imageBytesPercent,
			);
			add(
				where,
				"oversized images",
				pageB.oversizedImages.length,
				pageA.oversizedImages.length,
				pageA.oversizedImages.length > pageB.oversizedImages.length,
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
				add(
					where,
					"input-to-frame p95 ms",
					b,
					a,
					a > FRAME_BUDGET_MS && pct(b, a) > INPUT_TO_FRAME_PERCENT,
				);
			}
		}
	}
	return { rows, regressions: rows.filter((r) => r.regression) };
}

const rowKey = (r) => `${r.profile}|${r.where}|${r.metric}`;

export function median(values) {
	const sorted = values.filter((v) => typeof v === "number").toSorted((a, b) => a - b);
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A copy of `profile` whose re-measured screens and cold starts carry the
 * median of the original measurement and the extra samples.
 */
export function withSamples(profile, extra) {
	if (!extra) return profile;
	const pages = (profile.pages ?? []).map((page) => {
		const samples = extra.pages?.[`${page.viewport} ${page.name}`];
		if (!samples || samples.length === 0) return page;
		const all = [
			{
				cls: page.cls,
				apiCount: page.api.count,
				imageBytes: page.bytesByType?.Image ?? 0,
				oversized: page.oversizedImages.length,
			},
			...samples,
		];
		return {
			...page,
			cls: median(all.map((s) => s.cls)),
			api: { ...page.api, count: median(all.map((s) => s.apiCount)) },
			bytesByType: { ...page.bytesByType, Image: median(all.map((s) => s.imageBytes)) },
			oversizedImages: Array.from({ length: Math.round(median(all.map((s) => s.oversized))) }),
		};
	});
	let coldStart = profile.coldStart;
	if (coldStart && extra.coldStart?.length > 0) {
		const all = [coldStart, ...extra.coldStart];
		coldStart = Object.fromEntries(
			Object.keys(coldStart).map((key) => [
				key,
				{ ...coldStart[key], ttfbMs: median(all.map((c) => c[key]?.ttfbMs)) },
			]),
		);
	}
	return { ...profile, pages, coldStart };
}

/** What to measure again for a set of candidate regressions, per profile. */
export function confirmationPlan(regressions) {
	const plan = new Map();
	for (const r of regressions) {
		const entry = plan.get(r.profile) ?? { pages: [], coldStart: false };
		if (r.where === "cold start") entry.coldStart = true;
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

/**
 * Re-judge candidate regressions on medians. A candidate stays a regression
 * only when the median comparison still crosses its threshold.
 */
export function confirmRegressions(candidates, before, after, extraBefore, extraAfter, thresholds) {
	const medianBefore = before.map((p) => withSamples(p, extraBefore[p.profile]));
	const medianAfter = after.map((p) => withSamples(p, extraAfter[p.profile]));
	const { rows } = compareResults(medianBefore, medianAfter, thresholds);
	const byKey = new Map(rows.map((r) => [rowKey(r), r]));
	return candidates.map((c) => {
		const m = byKey.get(rowKey(c));
		return {
			...c,
			medianBefore: m?.before ?? c.before,
			medianAfter: m?.after ?? c.after,
			confirmed: m ? m.regression : c.regression,
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
