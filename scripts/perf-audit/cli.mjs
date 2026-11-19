#!/usr/bin/env node
/**
 * pnpm perf:audit — measure shipped templates under their production
 * runtimes. See scripts/perf-audit/README.md.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { distortingOptions, parseArgs, USAGE } from "./lib/args.mjs";
import {
	coldBurstFailures,
	compareResults,
	confirmationPlan,
	confirmRegressions,
	evaluateBudgets,
} from "./lib/evaluate.mjs";
import { exitCode, runFailures } from "./lib/failures.mjs";
import { acquire, registerRun } from "./lib/locks.mjs";
import { generateMedia, generateScenarioUpload } from "./lib/media-gen.mjs";
import { PortRegistry } from "./lib/ports.mjs";
import { startPostgres } from "./lib/postgres.mjs";
import {
	allProfileIds,
	defaultProfileIds,
	resolveProfile,
	selectProfiles,
} from "./lib/profiles.mjs";
import { describeConfirmation, renderSummary } from "./lib/report.mjs";
import { remeasureProfile, runProfile } from "./lib/run-profile.mjs";

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

/**
 * Everything a run writes outside its results folder lives under its slot,
 * which one run holds at a time.
 */
function workspaceDirs({ slotDir, label, resultsDir, ports }) {
	const base = label === "primary" ? slotDir : join(slotDir, "compare");
	return {
		sites: join(base, "sites"),
		state: join(base, "state"),
		postgres: join(base, "postgres"),
		logs: join(resultsDir, "logs", label),
		scratch: join(base, "scratch"),
		dbTag: createHash("sha256").update(slotDir).digest("hex").slice(0, 6),
		ports,
	};
}

function startPostgresFor(profiles, dirs) {
	if (!profiles.some((p) => p.usesPostgres)) return null;
	return startPostgres({ stateDir: dirs.postgres, log: process.stdout, ports: dirs.ports });
}

/** Failed or broken re-measurements, as run errors: their samples cannot confirm or dismiss a regression. */
function confirmationErrors(extra, label) {
	return Object.entries(extra).flatMap(([profile, samples]) =>
		samples.errors.map((e) => ({
			profile: `${profile} (confirming, ${label})`,
			error: `${e.measurement}: ${e.error}`,
		})),
	);
}

/** Re-measure candidate regressions on one workspace's prepared sites. */
async function remeasureWorkspace({
	label,
	workspace,
	plan,
	options,
	browser,
	resultsDir,
	slot,
	scenarioUpload,
	mediaFiles,
}) {
	const dirs = workspaceDirs({ ...slot, label, resultsDir });
	const profiles = Array.from(plan.keys(), resolveProfile);
	const pg = await startPostgresFor(profiles, dirs);
	const out = {};
	try {
		for (const profile of profiles) {
			console.log(`  confirming ${profile.id} (${label})`);
			out[profile.id] = await remeasureProfile(
				{
					browser,
					profile,
					workspace,
					dirs,
					pg,
					options,
					mediaFiles,
					log: () => {},
					label,
					scenarioUpload,
				},
				{ ...plan.get(profile.id), samples: options.confirmSamples },
			);
		}
	} finally {
		await pg?.stop();
	}
	return out;
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
	slot,
}) {
	const dirs = workspaceDirs({ ...slot, label, resultsDir });
	const pg = await startPostgresFor(profiles, dirs);
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
	const slotName = options.sites ?? options.run ?? "default";
	const slotDir = join(auditDir, "work", slotName);
	const resultsDir = join(auditDir, "results", name);
	const releaseSlot = await acquire(join(slotDir, "lock.json"), {
		what: `the "${slotName}" run slot (${slotDir}); pass a different --run or --sites to run in parallel`,
	});
	const releaseResults = await acquire(join(auditDir, "results", `${name}.lock.json`), {
		what: `the "${name}" results folder (${resultsDir})`,
	});
	mkdirSync(resultsDir, { recursive: true });
	const ports = new PortRegistry({ owner: `${harnessRoot} ${slotName}` });
	const registration = registerRun({ slot: slotDir, results: resultsDir });
	const slot = { slotDir, ports };
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
		slot: slotDir,
		otherRuns: [],
		profiles: [],
		errors: [],
	};
	const noteOtherRuns = () => {
		for (const other of registration.others()) {
			if (!run.otherRuns.some((o) => o.pid === other.pid)) {
				run.otherRuns.push({ pid: other.pid, slot: other.slot, since: other.since });
			}
		}
	};
	noteOtherRuns();
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
			onProfile: () => {
				noteOtherRuns();
				writePartial();
			},
			slot,
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
				onProfile: () => {
					noteOtherRuns();
					writePartial();
				},
				slot,
			});
			run.errors.push(...other.errors.map((e) => ({ ...e, profile: `${e.profile} (compare)` })));
			run.comparison = compareResults(run.compareProfiles, run.profiles, options.thresholds);
			const candidates = run.comparison.regressions;
			if (candidates.length > 0 && options.confirmSamples > 0) {
				console.log(`\nConfirming ${candidates.length} candidate regression(s)`);
				const plan = confirmationPlan(candidates);
				const shared = { plan, options, browser, resultsDir, slot, scenarioUpload, mediaFiles };
				const extraBefore = await remeasureWorkspace({
					...shared,
					label: "compare",
					workspace: compare,
				});
				const extraAfter = await remeasureWorkspace({ ...shared, label: "primary", workspace });
				run.errors.push(
					...confirmationErrors(extraBefore, "compare"),
					...confirmationErrors(extraAfter, "primary"),
				);
				const judged = confirmRegressions(
					candidates,
					run.compareProfiles,
					run.profiles,
					extraBefore,
					extraAfter,
					options.thresholds,
				);
				run.comparison.candidates = judged;
				run.comparison.confirmationSamples = { compare: extraBefore, primary: extraAfter };
				run.comparison.regressions = judged.filter((c) => c.confirmed);
			}
		}
	} finally {
		noteOtherRuns();
		await browser.close();
		ports.releaseAll();
		registration.release();
		releaseResults();
		releaseSlot();
	}

	run.budgetFailures = evaluateBudgets(run.profiles, options.budgets);
	run.burstFailures = coldBurstFailures(run.profiles);
	run.failures = runFailures(run);
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
			console.log(
				`  ${r.profile} ${r.where} ${r.metric}: ${r.medianBefore ?? r.before} -> ${r.medianAfter ?? r.after} (${describeConfirmation(r)})`,
			);
		}
		const noise = (run.comparison.candidates ?? []).filter((c) => !c.confirmed);
		if (noise.length > 0) {
			console.log(`Compare: ${noise.length} candidate(s) did not hold up on repeat samples.`);
		}
		const incomparable = new Set(
			run.comparison.rows.filter((r) => r.incomparable).map((r) => `${r.profile} ${r.where}`),
		);
		if (incomparable.size > 0) {
			console.log(
				`Compare: ${incomparable.size} screen(s) not compared because a capture was incomplete.`,
			);
		}
	}
	for (const f of run.budgetFailures) {
		console.log(`Over budget: ${f.profile} ${f.budget} ${f.actual} > ${f.limit} (${f.where})`);
	}
	for (const f of run.burstFailures) {
		const e = f.example;
		console.log(
			`Cold-start burst: ${f.profile} ${f.failed} of ${f.requests} requests failed (first: ${e.status || e.error} ${e.path})`,
		);
	}
	for (const f of run.failures) {
		console.log(`Failed: ${f.profile} ${f.check}${f.where ? ` (${f.where})` : ""}: ${f.detail}`);
	}
	return exitCode(run);
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.error(error?.stack ?? error);
		process.exit(1);
	});
