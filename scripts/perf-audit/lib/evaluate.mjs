/**
 * Budgets and before/after comparison over profile results.
 */

const KiB = 1024;

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
			if (!sB || sA.cls === undefined || sB.cls === undefined) continue;
			add(`scenario ${sA.name}`, "CLS", sB.cls, sA.cls, sA.cls - sB.cls > thresholds.cls);
		}
	}
	return { rows, regressions: rows.filter((r) => r.regression) };
}
