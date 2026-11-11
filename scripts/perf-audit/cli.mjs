#!/usr/bin/env node
/**
 * pnpm perf:audit — measure shipped templates under their production
 * runtimes. See scripts/perf-audit/README.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { distortingOptions, parseArgs, USAGE } from "./lib/args.mjs";
import { compareResults, evaluateBudgets } from "./lib/evaluate.mjs";
import { generateMedia, generateScenarioUpload } from "./lib/media-gen.mjs";
import { startPostgres } from "./lib/postgres.mjs";
import {
	allProfileIds,
	defaultProfileIds,
	resolveProfile,
	selectProfiles,
} from "./lib/profiles.mjs";
import { renderSummary } from "./lib/report.mjs";
import { runProfile } from "./lib/run-profile.mjs";

const harnessRoot = resolve(import.meta.dirname, "../..");
const auditDir = join(harnessRoot, ".perf-audit");

function revision(dir) {
	try {
		return {
			head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(),
			dirty:
				execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
					cwd: dir,
					encoding: "utf8",
				}).trim().length > 0,
		};
	} catch {
		return null;
	}
}

function checkWorkspace(dir) {
	if (!existsSync(join(dir, "packages/core/dist"))) {
		throw new Error(`${dir} has no built packages. Run pnpm install and pnpm build there first.`);
	}
}

function listProfiles() {
	const defaults = new Set(defaultProfileIds());
	for (const id of allProfileIds()) {
		const p = resolveProfile(id);
		console.log(
			`${defaults.has(id) ? "*" : " "} ${id.padEnd(36)} ${p.runtime.padEnd(8)} ${p.database.padEnd(11)} images: ${p.images}`,
		);
	}
	console.log("\n* default profile set");
}

async function runWorkspace({
	label,
	workspace,
	profiles,
	options,
	browser,
	mediaFiles,
	scenarioUpload,
	resultsDir,
	results,
	onProfile,
}) {
	const base = label === "primary" ? auditDir : join(auditDir, "compare");
	const dirs = {
		sites: join(base, "sites"),
		state: join(base, "state"),
		logs: join(resultsDir, "logs", label),
		scratch: join(base, "scratch"),
	};
	const needsPg = profiles.some((p) => p.usesPostgres);
	const pg = needsPg
		? await startPostgres({ stateDir: join(auditDir, "postgres"), log: process.stdout })
		: null;
	const errors = [];
	try {
		for (const profile of profiles) {
			console.log(`\n== ${profile.id} (${label}: ${workspace})`);
			try {
				results.push(
					await runProfile({
						browser,
						profile,
						workspace,
						dirs,
						pg,
						options,
						mediaFiles,
						scenarioUpload,
						log: (line) => console.log(line),
						resultsDir,
						label,
					}),
				);
				onProfile?.();
			} catch (error) {
				console.error(`  ${profile.id} failed: ${error?.stack ?? error}`);
				errors.push({ profile: profile.id, error: String(error?.stack ?? error) });
			}
		}
	} finally {
		await pg?.stop();
	}
	return { errors };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(USAGE);
		return 0;
	}
	if (options.list) {
		listProfiles();
		return 0;
	}
	const workspace = resolve(options.workspace ?? harnessRoot);
	const compare = options.compare ? resolve(options.compare) : null;
	checkWorkspace(workspace);
	if (compare) checkWorkspace(compare);
	const profiles = selectProfiles(options);

	const name = options.run ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const resultsDir = join(auditDir, "results", name);
	mkdirSync(resultsDir, { recursive: true });
	const mediaFiles = await generateMedia(join(auditDir, "media"));
	const scenarioUpload = await generateScenarioUpload(join(auditDir, "media"));

	const launchEnv = { ...process.env };
	if (options.locale === "ar" && !launchEnv.FONTCONFIG_FILE) {
		console.warn("Arabic run without FONTCONFIG_FILE: Arabic text may render with fallback fonts.");
	}
	const browser = await chromium.launch({
		channel: "chromium",
		env: launchEnv,
		args: ["--host-resolver-rules=MAP localhost 127.0.0.1"],
	});

	const run = {
		name,
		startedAt: new Date().toISOString(),
		options: { ...options },
		distorting: distortingOptions(options),
		workspace: { path: workspace, revision: revision(workspace) },
		compare: compare ? { path: compare, revision: revision(compare) } : null,
		browser: browser.version(),
		profiles: [],
		errors: [],
	};
	const resultsPath = join(resultsDir, "results.json");
	const writePartial = () =>
		writeFileSync(resultsPath, JSON.stringify({ ...run, partial: true }, null, "\t"));
	try {
		const primary = await runWorkspace({
			label: "primary",
			workspace,
			profiles,
			options,
			browser,
			mediaFiles,
			scenarioUpload,
			resultsDir,
			results: run.profiles,
			onProfile: writePartial,
		});
		run.errors.push(...primary.errors);
		if (compare) {
			const other = await runWorkspace({
				label: "compare",
				workspace: compare,
				profiles,
				options,
				browser,
				mediaFiles,
				scenarioUpload,
				resultsDir,
				results: (run.compareProfiles = []),
				onProfile: writePartial,
			});
			run.errors.push(...other.errors.map((e) => ({ ...e, profile: `${e.profile} (compare)` })));
			run.comparison = compareResults(run.compareProfiles, run.profiles, options.thresholds);
		}
	} finally {
		await browser.close();
	}

	run.budgetFailures = evaluateBudgets(run.profiles, options.budgets);
	run.finishedAt = new Date().toISOString();
	writeFileSync(resultsPath, JSON.stringify(run, null, "\t"));
	const summary = renderSummary(run);
	writeFileSync(join(resultsDir, "summary.md"), summary);
	console.log(`\nResults: ${join(resultsDir, "summary.md")}`);
	if (run.comparison) {
		console.log(
			run.comparison.regressions.length === 0
				? "Compare: no regressions over the thresholds."
				: `Compare: ${run.comparison.regressions.length} regression(s):`,
		);
		for (const r of run.comparison.regressions) {
			console.log(`  ${r.profile} ${r.where} ${r.metric}: ${r.before} -> ${r.after}`);
		}
	}
	for (const f of run.budgetFailures) {
		console.log(`Over budget: ${f.profile} ${f.budget} ${f.actual} > ${f.limit} (${f.where})`);
	}
	if (run.errors.length > 0) return 1;
	return run.budgetFailures.length > 0 ? 1 : 0;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error?.stack ?? error);
		process.exit(1);
	});
