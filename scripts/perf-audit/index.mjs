#!/usr/bin/env node
/**
 * Measures CLS, LCP, blocking time, API traffic, transfer size and server
 * query counts for every admin route, public page and interaction scenario
 * against a production build of fixtures/perf-site. See scripts/perf-audit/README.md.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";

import { NETWORK_PRESETS, VIEWPORTS, runMeasurement } from "./measure.mjs";
import { startPostgres } from "./postgres.mjs";
import { compareDbLatency, compareStability, compareToBaseline, renderSummary } from "./report.mjs";
import { discoverTargets } from "./routes.mjs";
import { SCENARIOS } from "./scenarios.mjs";
import { buildSite, ensurePostgresTemplate, ensureSeed, startSite } from "./site.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const RESULTS_DIR = join(ROOT, ".perf-audit/results");

const USAGE = `Usage: pnpm perf:audit [options]

  --max-initial-js-gz <KB> Fail routes exceeding the static entry import graph budget (KiB)
  --react-profile       Build with React profiling and count committed fiber renders
  --plugins             Build the fixture with the forms plugin and measure its admin pages
  --gzip                Serve the fixture through a local streaming gzip proxy
  --midpoint-ms <ms>     Sample scenario geometry after this delay into each step
  --cold                Restart the server before every route or scenario (TCP-only readiness)
  --role <name>         admin (default), editor, author, contributor or subscriber
  --locale <code>       Admin locale cookie and browser locale (default en)
  --dark                Use dark color scheme
  --query-timeline <text> Export full SQL events for request paths containing text
  --only <text[,text]>   Measure ids containing the text, e.g. admin:/media or scenario:editor; end with $ for an exact id
  --viewport <name>      desktop, mobile or both (default both)
  --slow-api <ms>        Delay every admin API response by this many milliseconds
  --hold <text>          Hold API responses whose URL contains the text open, screenshot, then release
  --db <kind>            sqlite (default) or postgres (a real server; see EMDASH_TEST_PG)
  --db-latency <ms>      Added round-trip delay per Postgres query, via a TCP proxy (implies --db postgres)
  --cpu <rate>           Chrome CPU throttling rate, e.g. 4
  --network <preset>     ${Object.keys(NETWORK_PRESETS).join(" or ")}
  --runs <n>             Passes over the whole selection (reports the median by CLS); default 1
  --screenshots          Save a screenshot of each final state
  --baseline <path>      Compare with an earlier results.json
  --max-cls <value>      Exit non-zero if any measurement's CLS exceeds this value
  --skip-build           Reuse the existing production build
  --reseed               Regenerate the seeded database
  --no-fonts             Build without the default web fonts (no network needed)
  --headed               Show the browser
  --out <name>           Results folder name (default: timestamp)
  --list                 Print the discovered targets and exit
`;

function readOptions() {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((arg) => arg !== "--"),
		options: {
			"max-initial-js-gz": { type: "string" },
			"react-profile": { type: "boolean", default: false },
			gzip: { type: "boolean", default: false },
			plugins: { type: "boolean", default: false },
			"midpoint-ms": { type: "string", default: "0" },
			cold: { type: "boolean", default: false },
			role: { type: "string", default: "admin" },
			locale: { type: "string", default: "en" },
			dark: { type: "boolean", default: false },
			"query-timeline": { type: "string" },
			only: { type: "string" },
			viewport: { type: "string", default: "both" },
			"slow-api": { type: "string", default: "0" },
			db: { type: "string" },
			"db-latency": { type: "string", default: "0" },
			hold: { type: "string" },
			cpu: { type: "string", default: "1" },
			network: { type: "string" },
			runs: { type: "string", default: "1" },
			screenshots: { type: "boolean", default: false },
			baseline: { type: "string" },
			"max-cls": { type: "string" },
			"skip-build": { type: "boolean", default: false },
			reseed: { type: "boolean", default: false },
			"no-fonts": { type: "boolean", default: false },
			headed: { type: "boolean", default: false },
			out: { type: "string" },
			list: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		process.stdout.write(USAGE);
		process.exit(0);
	}
	if (values.network && !NETWORK_PRESETS[values.network])
		throw new Error(`Unknown --network ${values.network}`);
	if (!["desktop", "mobile", "both"].includes(values.viewport))
		throw new Error("--viewport must be desktop, mobile or both");
	if (!["admin", "editor", "author", "contributor", "subscriber"].includes(values.role))
		throw new Error("Unknown --role; use admin, editor, author, contributor or subscriber");
	if (values["react-profile"] && values["skip-build"])
		throw new Error("--react-profile requires a rebuild; omit --skip-build");
	for (const name of [
		"midpoint-ms",
		"max-initial-js-gz",
		"max-cls",
		"db-latency",
		"slow-api",
		"cpu",
		"runs",
	]) {
		if (
			values[name] !== undefined &&
			(!Number.isFinite(Number(values[name])) || Number(values[name]) < 0)
		)
			throw new Error(`--${name} must be a non-negative finite number`);
	}
	const dbLatency = Number(values["db-latency"]);
	if (values.db && !["sqlite", "postgres"].includes(values.db))
		throw new Error("--db must be sqlite or postgres");
	if (dbLatency > 0 && values.db === "sqlite") throw new Error("--db-latency needs --db postgres");
	return {
		db: values.db ?? (dbLatency > 0 ? "postgres" : "sqlite"),
		dbLatency,
		cold: values.cold,
		gzip: values.gzip,
		plugins: values.plugins,
		midpointMs: Number(values["midpoint-ms"]),
		reactProfile: values["react-profile"],
		maxInitialJsGz:
			values["max-initial-js-gz"] === undefined ? undefined : Number(values["max-initial-js-gz"]),
		role: values.role,
		locale: values.locale,
		dark: values.dark,
		queryTimeline: values["query-timeline"],
		only: values.only
			?.split(",")
			.map((text) => text.trim())
			.filter(Boolean),
		viewports: values.viewport === "both" ? Object.keys(VIEWPORTS) : [values.viewport],
		slowApi: Number(values["slow-api"]),
		hold: values.hold,
		cpu: Number(values.cpu),
		network: values.network,
		runs: Math.max(1, Number(values.runs)),
		screenshots: values.screenshots,
		baseline: values.baseline,
		maxCls: values["max-cls"] === undefined ? undefined : Number(values["max-cls"]),
		skipBuild: values["skip-build"],
		reseed: values.reseed,
		fonts: !values["no-fonts"],
		headed: values.headed,
		out: values.out,
		list: values.list,
	};
}

async function signIn(browser, site) {
	const context = await browser.newContext({ baseURL: site.baseUrl });
	const response = await context.request.post("/_emdash/api/auth/magic-link/verify", {
		headers: { "X-EmDash-Request": "1", Origin: site.baseUrl },
		data: { token: site.loginToken },
	});
	if (!response.ok())
		throw new Error(`Sign-in failed (${response.status()}): ${await response.text()}`);
	const storageState = await context.storageState();
	await context.close();
	return storageState;
}

function gitLabel() {
	const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: ROOT,
		encoding: "utf8",
	}).trim();
	const dirty = execFileSync("git", ["status", "--porcelain"], {
		cwd: ROOT,
		encoding: "utf8",
	}).trim();
	return dirty ? `${sha}+dirty` : sha;
}

function matchesFilter(target, only) {
	return (
		!only ||
		only.some((text) =>
			text.endsWith("$") ? target.id === text.slice(0, -1) : target.id.includes(text),
		)
	);
}

function medianByCls(passes) {
	const byKey = new Map();
	for (const pass of passes) {
		for (const entry of pass) {
			if (!byKey.has(entry.key)) byKey.set(entry.key, []);
			byKey.get(entry.key).push(entry);
		}
	}
	return Array.from(byKey.values(), (results) => {
		const sorted = results
			.filter((entry) => entry.metrics)
			.toSorted((a, b) => a.metrics.cls - b.metrics.cls);
		return sorted[Math.floor((sorted.length - 1) / 2)] ?? results[0];
	});
}

async function main() {
	const options = readOptions();
	const startedAt = new Date();

	if (!options.skipBuild && !options.list) {
		process.stdout.write("Building production fixture...\n");
		buildSite({
			fonts: options.fonts,
			db: options.db,
			reactProfile: options.reactProfile,
			plugins: options.plugins,
		});
	}
	process.stdout.write("Preparing seed...\n");
	const seedDir = await ensureSeed({ reseed: options.reseed });
	const postgres = options.db === "postgres" ? await startPostgres() : undefined;
	const template = postgres
		? await ensurePostgresTemplate({ reseed: options.reseed, postgres, seedDir })
		: undefined;
	const site = await startSite({
		db: options.db,
		seedDir,
		postgres,
		template,
		latencyMs: options.dbLatency,
		role: options.role,
		gzip: options.gzip,
		plugins: options.plugins,
	});

	const { targets, unreachable } = discoverTargets(site.params, { plugins: options.plugins });
	const allTargets = [
		...targets,
		...SCENARIOS.map((scenario) => ({ ...scenario, kind: "scenario", auth: true })),
	];
	if (options.list) {
		process.stdout.write(`${allTargets.map((target) => target.id).join("\n")}\n`);
		if (unreachable.length > 0)
			process.stdout.write(
				`\nUnreachable:\n${unreachable.map((item) => `${item.pattern}: ${item.reason}`).join("\n")}\n`,
			);
		await site.stop();
		return;
	}
	const selected = allTargets.filter((target) => matchesFilter(target, options.only));
	if (selected.length === 0) {
		await site.stop();
		throw new Error(
			`No targets match --only ${options.only?.join(",")}. Run with --list to see the ids.`,
		);
	}

	const outName = options.out ?? startedAt.toISOString().replaceAll(/[:.]/g, "-");
	const outDir = join(RESULTS_DIR, outName);
	mkdirSync(join(outDir, "shots"), { recursive: true });

	const browser = await chromium.launch({ headless: !options.headed });
	const passes = [];
	let serverDied = false;
	try {
		site.storageState = await signIn(browser, site);
		const total = selected.length * options.viewports.length * options.runs;
		let completed = 0;
		for (let pass = 0; pass < options.runs; pass++) {
			const results = [];
			for (const viewportName of options.viewports) {
				for (const target of selected) {
					if (options.cold) await site.restart();
					const result = await runMeasurement({
						browser,
						site,
						options,
						target,
						viewportName,
						pass,
						outDir,
					});
					results.push(result);
					completed++;
					const cls = result.metrics ? result.metrics.cls.toFixed(3) : "n/a";
					process.stdout.write(
						`[${completed}/${total}] ${result.key} ${result.status} cls=${cls}\n`,
					);
				}
			}
			passes.push(results);
		}
	} catch (error) {
		serverDied = true;
		process.stderr.write(`${site.serverOutput()}\n`);
		throw error;
	} finally {
		await browser.close();
		await site.stop();
	}

	const entries = medianByCls(passes);
	const stability = compareStability(passes);
	const baselineResults = options.baseline
		? JSON.parse(readFileSync(options.baseline, "utf8"))
		: null;
	const comparison = baselineResults ? compareToBaseline(entries, baselineResults) : null;
	const meta = {
		git: gitLabel(),
		cold: options.cold,
		gzip: options.gzip,
		plugins: options.plugins,
		midpointMs: options.midpointMs,
		reactProfile: options.reactProfile,
		role: options.role,
		locale: options.locale,
		dark: options.dark,
		startedAt: startedAt.toISOString(),
		durationMs: Date.now() - startedAt.getTime(),
		runs: options.runs,
		viewports: options.viewports,
		fonts: options.fonts,
		db: options.db,
		dbLatency: options.dbLatency,
		slowApi: options.slowApi,
		cpu: options.cpu,
		network: options.network,
		only: options.only?.join(","),
		serverDied,
	};
	const dbLatencyComparison =
		baselineResults && baselineResults.meta.dbLatency !== options.dbLatency
			? compareDbLatency(baselineResults, { entries, meta })
			: null;
	writeFileSync(
		join(outDir, "results.json"),
		JSON.stringify(
			{
				meta,
				entries,
				unreachable,
				stability,
				comparison,
				dbLatencyComparison,
				passes: options.runs > 1 ? passes : undefined,
			},
			null,
			"\t",
		),
	);
	const summaryPath = join(outDir, "summary.md");
	writeFileSync(
		summaryPath,
		renderSummary({ meta, entries, unreachable, stability, comparison, dbLatencyComparison }) +
			"\n## Initial JS (static entry imports)\n\n| Route | gzip KiB |\n| --- | ---: |\n" +
			entries
				.filter((entry) => entry.metrics?.initialJsGzip !== undefined)
				.map((entry) => `| ${entry.key} | ${(entry.metrics.initialJsGzip / 1024).toFixed(1)} |`)
				.join("\n"),
	);
	rmSync(join(RESULTS_DIR, "latest"), { force: true });
	symlinkSync(outName, join(RESULTS_DIR, "latest"));

	process.stdout.write(
		`\nResults: ${outDir}\nSummary: ${summaryPath}\nDuration: ${Math.round(meta.durationMs / 1000)}s\n`,
	);

	if (entries.some((entry) => entry.status === "error")) process.exitCode = 1;
	const overJs = entries.filter(
		(entry) => entry.metrics?.initialJsGzip / 1024 > options.maxInitialJsGz,
	);
	if (overJs.length) {
		process.stderr.write(
			`Initial JS budget ${options.maxInitialJsGz} KiB exceeded: ${overJs.map((entry) => entry.key).join(", ")}\n`,
		);
		process.exitCode = 1;
	}
	if (options.maxCls !== undefined) {
		const over = entries.filter((entry) => entry.metrics && entry.metrics.cls > options.maxCls);
		if (over.length > 0) {
			process.stderr.write(
				`\nCLS budget ${options.maxCls} exceeded:\n${over.map((entry) => `  ${entry.key}: ${entry.metrics.cls.toFixed(4)}`).join("\n")}\n`,
			);
			process.exitCode = 1;
		}
	}
}

process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
