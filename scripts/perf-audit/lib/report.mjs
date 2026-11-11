/**
 * results.json and summary.md for a run.
 */

import { serverGzipBytes } from "./evaluate.mjs";

const kib = (bytes) =>
	bytes === null || bytes === undefined ? "-" : `${(bytes / 1024).toFixed(0)} KiB`;
const ms = (v) => (v === null || v === undefined ? "-" : `${v} ms`);
const cell = (v) => String(v ?? "-").replaceAll("|", "\\|");

function table(headers, rows) {
	if (rows.length === 0) return "_None._\n";
	return (
		[
			`| ${headers.join(" | ")} |`,
			`| ${headers.map(() => "---").join(" | ")} |`,
			...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
		].join("\n") + "\n"
	);
}

function shortUrl(url, origin) {
	const s = url.replace(origin, "");
	return s.length > 90 ? `${s.slice(0, 87)}...` : s;
}

function topSource(page) {
	const shift = page.clsAttribution?.[0];
	const src = shift?.sources?.[0];
	if (!src) return "-";
	const moved = src.moved ? ` (dy ${src.moved.dy}, dh ${src.moved.dh})` : "";
	return `${src.node ?? "?"}${moved} at ${shift.at} ms`;
}

function oversizedRows(profile) {
	const seen = new Map();
	for (const page of profile.pages ?? []) {
		for (const img of page.oversizedImages ?? []) {
			const key = `${page.viewport}|${img.src}`;
			const entry = seen.get(key) ?? { ...img, viewport: page.viewport, screens: [] };
			entry.screens.push(page.name);
			seen.set(key, entry);
		}
	}
	return [...seen.values()].toSorted((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
}

export function renderSummary(run) {
	const lines = [];
	lines.push(`# Perf audit: ${run.name}`, "");
	lines.push(`- Started: ${run.startedAt}`);
	lines.push(
		`- Workspace: ${run.workspace.path} (${run.workspace.revision?.head?.slice(0, 9) ?? "?"}${run.workspace.revision?.dirty ? ", uncommitted changes" : ""})`,
	);
	if (run.compare) {
		lines.push(
			`- Compared with: ${run.compare.path} (${run.compare.revision?.head?.slice(0, 9) ?? "?"})`,
		);
	}
	lines.push(
		`- Viewports: ${run.options.viewports.join(", ")}; DB latency for Postgres: ${run.options.dbLatency} ms`,
	);
	if (run.distorting.length > 0) {
		lines.push(`- **Timings distorted by debugging options:** ${run.distorting.join(", ")}`);
	}
	if (run.options.locale !== "en" || run.options.dark) {
		lines.push(`- Locale: ${run.options.locale}${run.options.dark ? ", dark scheme" : ""}`);
	}
	lines.push("");

	if (run.budgetFailures.length > 0) {
		lines.push("## Budget failures", "");
		lines.push(
			table(
				["Profile", "Budget", "Limit", "Actual", "Where"],
				run.budgetFailures.map((f) => [f.profile, f.budget, f.limit, f.actual, f.where]),
			),
		);
	}

	if (run.comparison) {
		lines.push("## Compared with the other workspace", "");
		const regs = run.comparison.regressions;
		const candidates = run.comparison.candidates ?? [];
		const noise = candidates.filter((c) => !c.confirmed);
		lines.push(
			regs.length === 0
				? "No regressions over the thresholds.\n"
				: `${regs.length} regression(s), shown as medians when they were re-measured:\n`,
		);
		if (regs.length > 0) {
			lines.push(
				table(
					["Profile", "Where", "Metric", "Before", "After"],
					regs.map((r) => [
						r.profile,
						r.where,
						r.metric,
						r.medianBefore ?? r.before,
						r.medianAfter ?? r.after,
					]),
				),
			);
		}
		if (noise.length > 0) {
			lines.push(
				`${noise.length} first-pass difference(s) did not hold up when measured again (medians of ${run.options.confirmSamples + 1} samples per workspace):\n`,
			);
			lines.push(
				table(
					["Profile", "Where", "Metric", "First pass", "Medians"],
					noise.map((r) => [
						r.profile,
						r.where,
						r.metric,
						`${r.before} -> ${r.after}`,
						`${r.medianBefore} -> ${r.medianAfter}`,
					]),
				),
			);
		}
		lines.push(
			table(
				["Profile", "Metric", "Before", "After"],
				run.comparison.rows
					.filter((r) => r.where === "build" || r.where === "cold start")
					.map((r) => [r.profile, r.metric, r.before, r.after]),
			),
		);
	}

	const profiles = run.profiles;
	lines.push("## Profiles", "");
	lines.push(
		table(
			[
				"Profile",
				"Runtime",
				"Worst CLS",
				"Oversized images",
				"Server gzip",
				"Admin initial JS",
				"Cold start public / admin",
				"Restores",
			],
			profiles.map((p) => {
				const worst = (p.pages ?? []).toSorted((a, b) => b.cls - a.cls)[0];
				return [
					p.profile,
					p.versions?.server ?? p.runtime,
					worst ? `${worst.cls.toFixed(3)} (${worst.viewport} ${worst.name})` : "-",
					oversizedRows(p).length,
					kib(serverGzipBytes(p)),
					kib(p.initialAdminJs?.gzipBytes),
					p.coldStart
						? `${ms(p.coldStart.publicPage.ttfbMs)} / ${ms(p.coldStart.adminApi.ttfbMs)}`
						: "-",
					p.restores?.restores?.length ?? 0,
				];
			}),
		),
	);

	const allPages = profiles.flatMap((p) => (p.pages ?? []).map((page) => ({ profile: p, page })));
	lines.push("## Worst screens by layout shift", "");
	lines.push(
		table(
			["Profile", "Screen", "CLS", "Biggest shift"],
			allPages
				.filter(({ page }) => page.cls > 0)
				.toSorted((a, b) => b.page.cls - a.page.cls)
				.slice(0, 15)
				.map(({ profile, page }) => [
					profile.profile,
					`${page.viewport} ${page.name}`,
					page.cls.toFixed(4),
					topSource(page),
				]),
		),
	);

	lines.push("## Slowest screens", "");
	lines.push(
		table(
			[
				"Profile",
				"Screen",
				"LCP",
				"TBT",
				"API requests",
				"API waves",
				"Last API response",
				"Transfer",
			],
			allPages
				.toSorted((a, b) => (b.page.lcpMs ?? 0) - (a.page.lcpMs ?? 0))
				.slice(0, 15)
				.map(({ profile, page }) => [
					profile.profile,
					`${page.viewport} ${page.name}`,
					ms(page.lcpMs),
					ms(page.tbtMs),
					page.api.count,
					page.api.waves,
					ms(page.api.lastResponseMs),
					kib(page.transferBytes),
				]),
		),
	);

	lines.push("## Oversized images", "");
	lines.push(
		"More than 2x the pixels the screen needs (rendered size x device pixel ratio) and over 50 KiB.\n",
	);
	const overs = profiles.flatMap((p) => oversizedRows(p).map((img) => ({ p, img })));
	lines.push(
		table(
			["Profile", "Viewport", "Image", "Natural", "Needed", "Factor", "Bytes", "Screens"],
			overs
				.slice(0, 30)
				.map(({ p, img }) => [
					p.profile,
					img.viewport,
					shortUrl(img.src, p.origin) + (img.emulated ? " (emulated resize)" : ""),
					img.natural,
					img.needed,
					`${img.factor}x`,
					kib(img.bytes),
					[...new Set(img.screens)].slice(0, 3).join("; "),
				]),
		),
	);
	if (overs.length > 30) lines.push(`_${overs.length - 30} more in results.json._\n`);

	lines.push("## Build output", "");
	lines.push(
		table(
			[
				"Profile",
				"Server files",
				"Server bytes",
				"Server gzip",
				"Upload (wrangler dry run)",
				"Startup closure",
				"Client assets",
				"Admin initial JS",
			],
			profiles.map((p) => [
				p.profile,
				p.build?.server.files,
				kib(p.build?.server.bytes),
				kib(p.build?.server.gzipBytes),
				p.build?.upload
					? p.build.upload.ok
						? `${kib(p.build.upload.uploadBytes)} / gzip ${kib(p.build.upload.uploadGzipBytes)}, ${p.build.upload.files} files`
						: "dry run failed"
					: "-",
				p.build
					? `${p.build.startupClosure.modules} modules, ${kib(p.build.startupClosure.bytes)}`
					: "-",
				p.build ? `${p.build.clientAssets.files} files` : "-",
				p.initialAdminJs
					? `${kib(p.initialAdminJs.gzipBytes)} gzip, ${p.initialAdminJs.files} files`
					: "-",
			]),
		),
	);

	lines.push("Largest packages in the server bundle (from rolldown region markers):\n");
	lines.push(
		table(
			["Profile", "Packages"],
			profiles
				.filter((p) => p.build?.packages)
				.map((p) => [
					p.profile,
					p.build.packages
						.slice(0, 6)
						.map((x) => `${x.package} ${kib(x.bytes)}`)
						.join(", "),
				]),
		),
	);

	lines.push("## Cold starts", "");
	lines.push(
		table(
			[
				"Profile",
				"First public page TTFB",
				"First public page total",
				"First admin API TTFB",
				"Restart",
			],
			profiles
				.filter((p) => p.coldStart)
				.map((p) => [
					p.profile,
					ms(p.coldStart.publicPage.ttfbMs),
					ms(p.coldStart.publicPage.totalMs),
					ms(p.coldStart.adminApi.ttfbMs),
					ms(p.coldStart.publicPage.restartMs),
				]),
		),
	);

	const scenarioRows = profiles.flatMap((p) =>
		(p.scenarios ?? []).map((s) => [
			p.profile,
			s.name,
			s.passed === false ? "**moved**" : s.passed === true ? "ok" : "-",
			s.cls === undefined ? "-" : s.cls.toFixed(4),
			s.moved?.[0] ? `${s.moved[0].element} (${s.moved[0].delta}px)` : "-",
			s.summary ?? s.error ?? "",
		]),
	);
	lines.push("## Interaction scenarios", "");
	lines.push("Each scenario samples element positions and fails when something visible moved.\n");
	lines.push(
		table(["Profile", "Scenario", "Result", "CLS", "Largest move", "Notes"], scenarioRows),
	);

	const passRows = profiles.flatMap((p) => {
		const seen = new Map();
		for (const page of p.pages ?? []) {
			for (const r of page.serverPass ?? []) seen.set(r.path, r);
		}
		return [...seen.values()]
			.toSorted((a, b) => (b.dbWaves ?? b.queries) - (a.dbWaves ?? a.queries))
			.slice(0, 8)
			.map((r) => [
				p.profile,
				shortUrl(r.path, ""),
				r.queries,
				r.dbRoundTrips ?? "-",
				r.dbWaves ?? "-",
				r.dbConnections ?? "-",
				ms(r.totalMs),
			]);
	});
	lines.push("## Server work per request", "");
	lines.push(
		"Requests replayed one at a time. Round trips, waves and connections come from the Postgres latency proxy.\n",
	);
	lines.push(
		table(
			["Profile", "Request", "Queries", "Round trips", "Waves", "Connections", "Time"],
			passRows,
		),
	);

	const restoreRows = profiles.flatMap((p) =>
		(p.restores?.restores ?? []).map((r) => [p.profile, r.after, r.before, ms(r.ms)]),
	);
	lines.push("## Restores", "");
	lines.push(
		"The seeded snapshot was restored before a measurement whenever the previous one wrote state.\n",
	);
	lines.push(table(["Profile", "After (wrote state)", "Before", "Took"], restoreRows.slice(0, 40)));

	const serverErrorRows = profiles
		.filter((p) => p.serverErrors?.lines > 0 || p.serverCrashes > 0)
		.map((p) => [
			p.profile,
			p.serverErrors?.lines ?? 0,
			p.serverCrashes ?? 0,
			(p.serverErrors?.examples ?? []).slice(0, 3).join(" / "),
		]);
	if (serverErrorRows.length > 0) {
		lines.push("## Server errors", "");
		lines.push(
			"Error lines in the server output during the run. Check them before trusting the numbers above.\n",
		);
		lines.push(table(["Profile", "Error lines", "Crashes", "Examples"], serverErrorRows));
	}

	const errors = profiles.flatMap((p) =>
		(p.errors ?? []).map((e) => [p.profile, e.measurement, e.error.split("\n")[0]]),
	);
	if (run.errors?.length)
		errors.push(...run.errors.map((e) => [e.profile, "profile", e.error.split("\n")[0]]));
	if (errors.length > 0) {
		lines.push("## Errors", "");
		lines.push(table(["Profile", "Measurement", "Error"], errors));
	}
	return lines.join("\n");
}
