const kb = (bytes) => `${Math.round(bytes / 1024)}`;
const num = (value, digits = 3) =>
	value === null || value === undefined ? "–" : Number(value).toFixed(digits);
const ms = (value) => (value === null || value === undefined ? "–" : `${Math.round(value)}`);

function worstShift(entry, { includeInput = false } = {}) {
	const shift = entry.shifts
		.filter((candidate) => includeInput || !candidate.hadRecentInput)
		.toSorted((a, b) => b.value - a.value)
		.find((candidate) => candidate.sources.length > 0);
	if (!shift) return "–";
	const [source] = shift.sources;
	return `${num(shift.value)} @${shift.t}ms in \`${shift.step}\`: \`${source.selector.slice(-90)}\``;
}

function table(headers, rows) {
	return [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

function comparable(entries) {
	return entries.filter((entry) => entry.metrics && !entry.status.startsWith("redirected"));
}

const VISIBILITY_THRESHOLD = 0.0005;

const delta = (after, before) => (after ?? 0) - (before ?? 0);

function collectApiTimings(entries) {
	const timings = new Map();
	for (const entry of entries) {
		if (!entry.apiTimings || entry.viewport !== "desktop") continue;
		for (const { endpoint, ms: duration } of entry.apiTimings) {
			if (!timings.has(endpoint)) timings.set(endpoint, []);
			timings.get(endpoint).push(duration);
		}
	}
	return timings;
}

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Ranks how much slower each public page and admin endpoint got between two DB latencies. */
export function compareDbLatency(baseline, current) {
	const beforeByKey = new Map(baseline.entries.map((entry) => [entry.key, entry]));
	const paired = current.entries.filter(
		(entry) => entry.metrics && beforeByKey.get(entry.key)?.metrics,
	);

	const publicPages = paired
		.filter((entry) => entry.id.startsWith("public:") && entry.viewport === "desktop")
		.map((entry) => {
			const before = beforeByKey.get(entry.key).metrics;
			return {
				key: entry.id,
				beforeMs: before.documentMs,
				afterMs: entry.metrics.documentMs,
				addedMs: delta(entry.metrics.documentMs, before.documentMs),
				queries: entry.metrics.queries.total,
				waves: entry.metrics.queries.waves,
			};
		})
		.toSorted((a, b) => b.addedMs - a.addedMs);

	const adminPages = paired
		.filter((entry) => entry.id.startsWith("admin:") && entry.viewport === "desktop")
		.map((entry) => {
			const before = beforeByKey.get(entry.key).metrics;
			return {
				key: entry.id,
				beforeMs: before.lastApiEndMs,
				afterMs: entry.metrics.lastApiEndMs,
				addedMs: delta(entry.metrics.lastApiEndMs, before.lastApiEndMs),
				queries: entry.metrics.queries.total,
				waves: entry.metrics.queries.waves,
				api: entry.metrics.apiRequests,
			};
		})
		.toSorted((a, b) => b.addedMs - a.addedMs);

	const beforeTimings = collectApiTimings(baseline.entries);
	const afterTimings = collectApiTimings(current.entries);
	const dbByEndpoint = new Map();
	for (const entry of current.entries) {
		if (!entry.metrics || entry.viewport !== "desktop") continue;
		for (const [endpoint, stats] of Object.entries(entry.metrics.queries.perEndpoint ?? {})) {
			const totals = dbByEndpoint.get(endpoint) ?? { requests: 0, queries: 0, waves: 0 };
			totals.requests += stats.requests;
			totals.queries += stats.queries;
			totals.waves += stats.waves;
			dbByEndpoint.set(endpoint, totals);
		}
	}
	const adminApi = [...afterTimings]
		.filter(([endpoint]) => beforeTimings.has(endpoint))
		.map(([endpoint, values]) => {
			const beforeMs = median(beforeTimings.get(endpoint));
			const afterMs = median(values);
			const db = dbByEndpoint.get(endpoint);
			return {
				key: endpoint,
				samples: values.length,
				beforeMs,
				afterMs,
				addedMs: afterMs - beforeMs,
				queries: db ? db.queries / db.requests : null,
				waves: db ? db.waves / db.requests : null,
			};
		})
		.toSorted((a, b) => b.addedMs - a.addedMs);

	return {
		beforeLatency: baseline.meta.dbLatency,
		afterLatency: current.meta.dbLatency,
		publicPages,
		adminPages,
		adminApi,
	};
}

function renderDbLatencySection(comparison) {
	const { beforeLatency, afterLatency, publicPages, adminPages, adminApi } = comparison;
	const row = (item) => [
		item.key,
		ms(item.beforeMs),
		ms(item.afterMs),
		`+${ms(item.addedMs)}`,
		item.queries === null ? "–" : Math.round(item.queries * 10) / 10,
		item.waves === null ? "–" : Math.round(item.waves * 10) / 10,
	];
	const header = ["key", `${beforeLatency}ms`, `${afterLatency}ms`, "added", "queries", "waves"];
	return [
		`## DB latency: ${beforeLatency}ms vs ${afterLatency}ms per round trip`,
		"",
		"Waves are sequential groups of DB round trips; added ms is roughly waves × latency.",
		"",
		"### Public pages (document load, logged out)",
		"",
		table(header, publicPages.slice(0, 15).map(row)),
		"",
		"### Admin API endpoints (median response)",
		"",
		table(header, adminApi.slice(0, 25).map(row)),
		"",
		"### Admin routes (last API response after navigation)",
		"",
		table(header, adminPages.slice(0, 15).map(row)),
		"",
	].join("\n");
}

export function renderSummary({
	meta,
	entries,
	unreachable,
	stability,
	comparison,
	dbLatencyComparison,
}) {
	const lines = [
		"# Perf audit summary",
		"",
		`${meta.git} · ${meta.startedAt} · passes: ${meta.runs} · viewports: ${meta.viewports.join(", ")}`,
		`Modes: db=${meta.db} dbLatency=${meta.dbLatency}ms fonts=${meta.fonts} slowApi=${meta.slowApi}ms cpu=${meta.cpu}x network=${meta.network ?? "none"} filter=${meta.only ?? "(all)"}`,
		"",
	];

	const measured = comparable(entries);
	const clsEntries = measured
		.filter((entry) => entry.metrics.cls >= VISIBILITY_THRESHOLD)
		.toSorted((a, b) => b.metrics.cls - a.metrics.cls);
	lines.push("## Layout shifts (CLS, excludes shifts within 500ms of input)", "");
	lines.push(
		clsEntries.length === 0
			? "None above the visible threshold."
			: table(
					["key", "CLS", "shifts", "worst shift"],
					clsEntries
						.slice(0, 30)
						.map((entry) => [
							entry.key,
							num(entry.metrics.cls),
							entry.metrics.shiftCount,
							worstShift(entry),
						]),
				),
		"",
	);

	const inputEntries = measured
		.filter((entry) => entry.metrics.clsAll - entry.metrics.cls >= VISIBILITY_THRESHOLD)
		.toSorted((a, b) => b.metrics.clsAll - a.metrics.clsAll);
	lines.push("## Shifts right after input (excluded from CLS but visible)", "");
	lines.push(
		inputEntries.length === 0
			? "None."
			: table(
					["key", "CLS incl. input", "input shifts", "worst shift"],
					inputEntries
						.slice(0, 20)
						.map((entry) => [
							entry.key,
							num(entry.metrics.clsAll),
							entry.metrics.inputShiftCount,
							worstShift(entry, { includeInput: true }),
						]),
				),
		"",
	);

	const byMetric = (metric, count = 12) =>
		measured
			.filter((entry) => entry.metrics[metric])
			.toSorted((a, b) => b.metrics[metric] - a.metrics[metric])
			.slice(0, count);

	lines.push(
		"## Total blocking time",
		"",
		table(
			["key", "TBT ms", "long tasks", "FCP", "LCP"],
			byMetric("tbt").map((entry) => [
				entry.key,
				ms(entry.metrics.tbt),
				entry.metrics.longTasks,
				ms(entry.metrics.fcp),
				ms(entry.metrics.lcp),
			]),
		),
		"",
	);
	lines.push(
		"## Largest contentful paint",
		"",
		table(
			["key", "LCP ms", "element"],
			byMetric("lcp")
				.filter((entry) => entry.kind === "route")
				.map((entry) => [
					entry.key,
					ms(entry.metrics.lcp),
					`\`${(entry.metrics.lcpElement ?? "").slice(-70)}\``,
				]),
		),
		"",
	);

	const duplicateEntries = measured
		.filter((entry) => entry.metrics.duplicates.length > 0)
		.toSorted((a, b) => b.metrics.duplicates.length - a.metrics.duplicates.length);
	lines.push("## Duplicate API requests (same request twice in one step)", "");
	lines.push(
		duplicateEntries.length === 0
			? "None."
			: table(
					["key", "API total", "duplicates"],
					duplicateEntries.slice(0, 15).map((entry) => [
						entry.key,
						entry.metrics.apiRequests,
						entry.metrics.duplicates
							.slice(0, 3)
							.map((item) => `${item.count}× ${item.request.slice(0, 80)}`)
							.join("<br>"),
					]),
				),
		"",
	);

	lines.push(
		"## Heaviest routes by API requests and server queries",
		"",
		table(
			["key", "API", "SQL queries", "waves", "DB wait ms", "most repeated query"],
			byMetric("apiRequests", 12).map((entry) => [
				entry.key,
				entry.metrics.apiRequests,
				entry.metrics.queries.total,
				entry.metrics.queries.waves,
				entry.metrics.queries.dbWallMs,
				entry.metrics.queries.repeated[0]
					? `${entry.metrics.queries.repeated[0].count}× ${entry.metrics.queries.repeated[0].query.slice(0, 80)}`
					: "–",
			]),
		),
		"",
	);

	lines.push(
		"## Transfer (KB, cold cache)",
		"",
		table(
			["key", "JS raw", "JS gzip", "CSS raw", "CSS gzip", "fonts", "images"],
			measured
				.filter((entry) => entry.kind === "route")
				.toSorted((a, b) => b.metrics.transfer.js - a.metrics.transfer.js)
				.slice(0, 10)
				.map((entry) => [
					entry.key,
					kb(entry.metrics.transfer.js),
					kb(entry.metrics.transfer.jsGzip),
					kb(entry.metrics.transfer.css),
					kb(entry.metrics.transfer.cssGzip),
					kb(entry.metrics.transfer.font),
					kb(entry.metrics.transfer.image),
				]),
		),
		"",
	);

	const notClean = entries.filter((entry) => entry.status !== "ok");
	lines.push(
		"## Coverage",
		"",
		`Measured ${entries.length} route/scenario runs. Unreachable patterns: ${unreachable.length}.`,
		"",
	);
	if (unreachable.length > 0)
		lines.push(
			table(
				["pattern", "reason"],
				unreachable.map((item) => [item.pattern, item.reason]),
			),
			"",
		);
	if (notClean.length > 0)
		lines.push(
			table(
				["key", "status", "detail"],
				notClean.map((entry) => [
					entry.key,
					entry.status,
					(entry.error ?? entry.consoleErrors?.[0] ?? "").slice(0, 120),
				]),
			),
			"",
		);
	const timeouts = entries.filter((entry) => entry.settleTimeouts > 0);
	if (timeouts.length > 0)
		lines.push(
			`Settle timed out (never went quiet): ${timeouts.map((entry) => entry.key).join(", ")}`,
			"",
		);

	if (stability) {
		lines.push(
			"## Run-to-run stability",
			"",
			`Compared ${stability.compared} measurements across the first two passes.`,
			`- CLS: ${stability.cls.withinTolerance}/${stability.compared} within 0.005 (max delta ${num(stability.cls.maxDelta, 4)} at ${stability.cls.maxKey})`,
			`- TBT: ${stability.tbt.withinTolerance}/${stability.compared} within 50ms (max delta ${ms(stability.tbt.maxDelta)}ms at ${stability.tbt.maxKey})`,
			`- API requests: ${stability.api.exact}/${stability.compared} identical`,
			"",
		);
	}

	if (dbLatencyComparison) lines.push(renderDbLatencySection(dbLatencyComparison));

	if (comparison) {
		lines.push("## Against baseline", "");
		lines.push(
			table(
				["key", "CLS before", "CLS now", "TBT before", "TBT now", "API before", "API now"],
				comparison.map((row) => [
					row.key,
					num(row.before.cls),
					num(row.after.cls),
					ms(row.before.tbt),
					ms(row.after.tbt),
					row.before.apiRequests,
					row.after.apiRequests,
				]),
			),
			"",
		);
	}

	return lines.join("\n");
}

/** Compares the first two passes, ignoring measurements that failed in either. */
export function compareStability(passes) {
	if (passes.length < 2) return null;
	const [first, second] = passes;
	const secondByKey = new Map(second.map((entry) => [entry.key, entry]));
	const stats = {
		compared: 0,
		cls: { withinTolerance: 0, maxDelta: 0, maxKey: "-" },
		tbt: { withinTolerance: 0, maxDelta: 0, maxKey: "-" },
		api: { exact: 0 },
	};
	for (const entry of first) {
		const other = secondByKey.get(entry.key);
		if (!entry.metrics || !other?.metrics) continue;
		stats.compared++;
		const clsDelta = Math.abs(entry.metrics.cls - other.metrics.cls);
		const tbtDelta = Math.abs(entry.metrics.tbt - other.metrics.tbt);
		if (clsDelta <= 0.005) stats.cls.withinTolerance++;
		if (clsDelta > stats.cls.maxDelta)
			Object.assign(stats.cls, { maxDelta: clsDelta, maxKey: entry.key });
		if (tbtDelta <= 50) stats.tbt.withinTolerance++;
		if (tbtDelta > stats.tbt.maxDelta)
			Object.assign(stats.tbt, { maxDelta: tbtDelta, maxKey: entry.key });
		if (entry.metrics.apiRequests === other.metrics.apiRequests) stats.api.exact++;
	}
	return stats;
}

export function compareToBaseline(entries, baseline) {
	const baselineByKey = new Map(baseline.entries.map((entry) => [entry.key, entry]));
	const rows = [];
	for (const entry of entries) {
		const before = baselineByKey.get(entry.key);
		if (!entry.metrics || !before?.metrics) continue;
		rows.push({
			key: entry.key,
			before: {
				cls: before.metrics.cls,
				tbt: before.metrics.tbt,
				apiRequests: before.metrics.apiRequests,
			},
			after: {
				cls: entry.metrics.cls,
				tbt: entry.metrics.tbt,
				apiRequests: entry.metrics.apiRequests,
			},
		});
	}
	return rows;
}
