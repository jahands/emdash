/**
 * Run every measurement for one profile, restoring the seeded snapshot
 * whenever a previous measurement wrote state.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { measureBuildOutput, measureInitialAdminJs } from "./build-output.mjs";
import { adminComposition, serverComposition } from "./bundle-composition.mjs";
import { burstPlan, measureColdBursts } from "./cold-burst.mjs";
import { measureColdStarts } from "./cold-start.mjs";
import { failedResponses } from "./evaluate.mjs";
import { pageProblems } from "./failures.mjs";
import { RestoreLedger } from "./ledger.mjs";
import { measurePage } from "./page-run.mjs";
import { prepareProfile, SEEDED } from "./prepare.mjs";
import { explainQueries, planRequests } from "./query-plans.mjs";
import { runScenarios } from "./scenarios.mjs";
import { planOwnerEdits } from "./seed.mjs";
import { eventsForPhase, serverPass } from "./server-pass.mjs";
import { buildTargets, filterTargets } from "./targets.mjs";
import { measureWrites } from "./writes.mjs";

/** An error's message with its cause, which is where `fetch failed` keeps the reason. */
export function describeError(error) {
	const cause = error?.cause;
	const reason = cause
		? ` (cause: ${cause.code ?? ""}${cause.code ? " " : ""}${cause.message ?? cause})`
		: "";
	const [first, ...rest] = String(error?.stack ?? error).split("\n");
	return [`${first}${reason}`, ...rest].join("\n").slice(0, 800);
}

function slug(text) {
	return text
		.replace(/[^a-z0-9]+/gi, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();
}

function readVersion(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8")).version;
	} catch {
		return null;
	}
}

function runtimeInfo(site, workspace) {
	const modules = join(site.siteDir, "node_modules");
	const info = {
		node: process.version,
		astro: readVersion(join(modules, "astro/package.json")),
		emdash: readVersion(resolve(workspace, "packages/core/package.json")),
	};
	if (site.profile.runtime === "workerd") {
		info.adapter = `@astrojs/cloudflare ${readVersion(join(modules, "@astrojs/cloudflare/package.json"))}`;
		info.wrangler = readVersion(join(modules, "wrangler/package.json"));
		info.server = "astro preview (wrangler dev, workerd)";
	} else {
		info.adapter = `@astrojs/node ${readVersion(join(modules, "@astrojs/node/package.json"))}`;
		info.server = "node dist/server/entry.mjs";
	}
	return info;
}

function readSeed(site) {
	return JSON.parse(readFileSync(join(site.siteDir, "seed/seed.json"), "utf8"));
}

function discoverTargets(site, prepared) {
	const seed = readSeed(site);
	const plan = planOwnerEdits(seed);
	const heaviest = prepared.seed.edits?.heaviestEntry;
	const firstPage = Object.values(seed.content ?? {}).flat()[0];
	return buildTargets({
		template: site.profile.template,
		collections: (seed.collections ?? []).map((c) => c.slug),
		heaviest: heaviest ? { ...heaviest, collection: plan.collection } : null,
		taxonomy: plan?.taxonomy ?? seed.taxonomies?.[0]?.name ?? null,
		term: plan?.terms?.[0] ?? null,
		menu: seed.menus?.[0]?.name ?? null,
		firstPageSlug: firstPage?.slug ?? null,
	});
}

/**
 * Whether `--only` leaves a profile-level pass in: no `--only`, or one
 * starting with `prefix` ("write" for the write pass, "plan" for query plans).
 */
export function passSelected(only, prefix) {
	return !only || only.length === 0 || only.some((o) => o.startsWith(prefix));
}

function writeTarget(site, prepared) {
	const plan = planOwnerEdits(readSeed(site));
	const heaviest = prepared.seed.edits?.heaviestEntry;
	return plan && heaviest ? { plan, heaviest } : null;
}

function coldBurstPlan(site, prepared) {
	const seed = readSeed(site);
	return burstPlan({
		publicPaths: discoverTargets(site, prepared)
			.filter((t) => t.kind === "public")
			.map((t) => t.path),
		collection: planOwnerEdits(seed)?.collection ?? seed.collections?.[0]?.slug ?? null,
	});
}

/** Screenshots of the --compare workspace go to their own folder so they don't overwrite this one's. */
export function screenshotRoot(resultsDir, label, profileId) {
	return join(resultsDir, label === "compare" ? "screenshots-compare" : "screenshots", profileId);
}

/**
 * Build output and bundle composition. They are seconds of synchronous work,
 * so they run once the server is closed: blocking the event loop that long
 * while keep-alive connections to the server are pooled lets the server close
 * them unnoticed, and the next request fails with "other side closed".
 */
function measureBuild(ctx, site, result) {
	try {
		result.build = measureBuildOutput(site, ctx.dirs.scratch);
		ctx.log(
			`  build: server ${(result.build.server.gzipBytes / 1024).toFixed(0)} KiB gzip${result.initialAdminJs ? `, admin initial JS ${(result.initialAdminJs.gzipBytes / 1024).toFixed(0)} KiB gzip` : ""}`,
		);
	} catch (error) {
		result.errors.push({ measurement: "build output", error: describeError(error) });
	}
	try {
		result.bundleComposition = {
			adminInitialJs: adminComposition(site, result.initialAdminJs?.urls ?? [], ctx.workspace),
			server: serverComposition(site, ctx.workspace),
		};
	} catch (error) {
		result.errors.push({ measurement: "bundle composition", error: describeError(error) });
	}
}

export async function runProfile(ctx) {
	const { browser, profile, workspace, options, log, resultsDir } = ctx;
	const shots = screenshotRoot(resultsDir, ctx.label, profile.id);
	const { site, cookies, prepared, reused } = await prepareProfile(ctx);
	const ledger = new RestoreLedger(SEEDED);
	const startedAt = Date.now();
	const result = {
		profile: profile.id,
		template: profile.template,
		platform: profile.platform,
		runtime: profile.runtime,
		database: profile.database,
		images: profile.images,
		origin: site.origin,
		dbLatencyMs: profile.usesPostgres ? options.dbLatency : null,
		postgres: profile.usesPostgres ? site.pg.source : null,
		versions: runtimeInfo(site, workspace),
		prepared: {
			reused,
			revision: prepared.revision,
			changedFiles: prepared.changedFiles,
			buildMs: prepared.build.buildMs,
			seedSize: prepared.seedSize ?? "default",
			seed: prepared.seed,
		},
		asShipped: prepared.asShipped ?? [],
		pages: [],
		scenarios: [],
		errors: [],
		selected: { screens: 0, scenarios: 0, writes: false, queryPlans: false },
	};

	await fetch(`${site.origin}/`, { headers: { "x-perf-phase": "warm-up" } }).then((r) =>
		r.arrayBuffer(),
	);

	const ensureClean = async (name) => {
		if (await site.ensureRunning()) {
			result.errors.push({ measurement: name, error: "The server had exited; restarted it." });
			ledger.record(`server exit before ${name}`, { declaredWrites: true });
		}
		if (!ledger.needsRestore()) return;
		const started = performance.now();
		await site.stop();
		await site.restore(SEEDED);
		await site.start();
		// Warm the runtime so the measurement is not a cold start.
		await fetch(`${site.origin}/`, { headers: { "x-perf-phase": "warm-up" } }).then((r) =>
			r.arrayBuffer(),
		);
		ledger.restored(name, performance.now() - started);
	};

	try {
		result.initialAdminJs = await measureInitialAdminJs(site, cookies);
		const targets = filterTargets(discoverTargets(site, prepared), options.only);
		result.selected.screens = targets.length * options.viewports.length;
		const passCache = new Map();
		const pixelCache = new Map();
		for (const viewport of options.viewports) {
			for (const target of targets) {
				const name = `${viewport} ${target.name}`;
				const phase = `page:${viewport}:${slug(target.name)}`;
				const shotBase = join(shots, viewport, slug(target.name));
				try {
					await ensureClean(name);
					const page = await measurePage({
						browser,
						site,
						target,
						viewport,
						cookies: target.kind === "admin" && !target.signedOut ? cookies : null,
						options,
						phase,
						paths: { screenshot: `${shotBase}.png`, hold: `${shotBase}-hold.png` },
						pixelCache,
					});
					const sql = eventsForPhase(site, phase).map((e) => e.sql);
					page.serverQueriesLogged = sql.length;
					ledger.record(name, { observedSql: sql });
					await ensureClean(`${name} (server pass)`);
					page.serverPass = await serverPass(site, page, {
						cookies: target.kind === "admin" && !target.signedOut ? cookies : null,
						cache: passCache,
					});
					ledger.record(`${name} (server pass)`, {
						observedSql: page.serverPass.flatMap((r) => r.sql),
					});
					result.pages.push({ name: target.name, kind: target.kind, viewport, ...page });
					log(
						`  ${viewport.padEnd(7)} ${target.name.padEnd(34)} CLS ${page.cls.toFixed(3)}  LCP ${page.lcpMs ?? "-"} ms  API ${page.api.count}  oversized ${page.oversizedImages.length}`,
					);
				} catch (error) {
					result.errors.push({
						measurement: name,
						error: describeError(error),
					});
					log(`  ${name}: failed: ${String(error).slice(0, 200)}`);
					ledger.record(name, { declaredWrites: true });
				}
			}
		}

		if (!options.skipScenarios) {
			result.scenarios = await runScenarios({
				browser,
				site,
				workspace,
				cookies,
				options,
				prepared,
				targets,
				ledger,
				ensureClean,
				log,
				mediaFile: ctx.scenarioUpload,
				screenshotDir: join(shots, "scenarios"),
			});
			result.selected.scenarios = result.scenarios.length;
		}

		const writeArgs = writeTarget(site, prepared);
		if (!options.skipWrites && passSelected(options.only, "write") && writeArgs) {
			result.selected.writes = true;
			try {
				await ensureClean("writes");
				const pass = await measureWrites(site, {
					cookies,
					...writeArgs,
					mediaFile: ctx.scenarioUpload,
				});
				result.writes = pass.ops;
				if (pass.error) result.errors.push({ measurement: "writes", error: pass.error });
				for (const w of pass.ops) {
					log(
						`  write ${w.op.padEnd(13)} ${w.status}  TTFB ${w.ttfbMs} ms  queries ${w.queries}${w.dbWaves === undefined ? "" : `  waves ${w.dbWaves}`}${w.afterResponse ? `  after response ${w.afterResponse.ms} ms` : ""}`,
					);
				}
			} catch (error) {
				result.errors.push({ measurement: "writes", error: describeError(error) });
			} finally {
				ledger.record("writes", { declaredWrites: true });
			}
		}

		if (profile.usesPostgres && passSelected(options.only, "plan")) {
			result.selected.queryPlans = true;
			try {
				await ensureClean("query plans");
				const seed = readSeed(site);
				result.queryPlans = await explainQueries(site, {
					cookies,
					requests: planRequests({
						collection: planOwnerEdits(seed)?.collection ?? seed.collections?.[0]?.slug ?? null,
						publicTargets: discoverTargets(site, prepared).filter((t) => t.kind === "public"),
					}),
				});
				const flagged = result.queryPlans.filter((q) => q.flags?.length > 0).length;
				log(`  query plans: ${result.queryPlans.length} queries explained, ${flagged} flagged`);
			} catch (error) {
				result.errors.push({ measurement: "query plans", error: describeError(error) });
			}
		}

		if (!options.skipColdStart) {
			try {
				await ensureClean("cold start");
				result.coldStart = await measureColdStarts(site, cookies);
				log(
					`  cold start: public ${result.coldStart.publicPage.ttfbMs} ms, admin API ${result.coldStart.adminApi.ttfbMs} ms`,
				);
			} catch (error) {
				result.errors.push({ measurement: "cold start", error: describeError(error) });
			}
			try {
				await ensureClean("cold-start burst");
				result.coldBurst = await measureColdBursts(site, {
					plan: coldBurstPlan(site, prepared),
					cookies,
					rounds: options.burstRounds,
				});
				ledger.record("cold-start burst", {
					observedSql: eventsForPhase(site, "cold-burst").map((e) => e.sql),
				});
				log(
					`  cold-start bursts: ${result.coldBurst.failedRequests} of ${result.coldBurst.requests} requests failed`,
				);
			} catch (error) {
				result.errors.push({
					measurement: "cold-start burst",
					error: describeError(error),
				});
			}
		}
		result.queryLog = site.queryEvents.length > 0 ? "available" : "unavailable";
	} finally {
		result.restores = ledger.toJSON();
		result.serverStarts = site.starts;
		result.serverCrashes = site.crashes;
		result.serverErrors = {
			lines: site.serverErrors.length,
			examples: [...new Set(site.serverErrors)].slice(0, 8),
		};
		result.failedResponses = failedResponses(result, site.origin);
		await site.close();
		measureBuild(ctx, site, result);
		result.seconds = Math.round((Date.now() - startedAt) / 1000);
	}
	return result;
}

/**
 * Measure some screens and the cold starts again, `samples` times each, on
 * the site this run prepared. Compare uses it to confirm a regression
 * before reporting it, because layout races and cold starts vary between
 * runs of the same code.
 */
export async function remeasureProfile(ctx, { pages, coldStart, writes, samples }) {
	const { browser, options } = ctx;
	const { site, cookies, prepared } = await prepareProfile({
		...ctx,
		options: { ...options, reuse: true },
	});
	const ledger = new RestoreLedger(SEEDED);
	const out = { pages: {}, coldStart: [], writes: [], errors: [] };
	const warm = () =>
		fetch(`${site.origin}/`, { headers: { "x-perf-phase": "warm-up" } }).then((r) =>
			r.arrayBuffer(),
		);
	const ensureClean = async (name) => {
		if (await site.ensureRunning()) {
			out.errors.push({ measurement: name, error: "The server had exited; restarted it." });
			ledger.record(`server exit before ${name}`, { declaredWrites: true });
		}
		if (!ledger.needsRestore()) return;
		const started = performance.now();
		await site.stop();
		await site.restore(SEEDED);
		await site.start();
		await warm();
		ledger.restored(name, performance.now() - started);
	};
	try {
		await warm();
		const targets = discoverTargets(site, prepared);
		for (const { name, viewport } of pages) {
			const target = targets.find((t) => t.name === name);
			const key = `${viewport} ${name}`;
			if (!target) {
				out.errors.push({ measurement: key, error: "No such screen to measure again" });
				continue;
			}
			out.pages[key] = [];
			for (let i = 0; i < samples; i++) {
				await ensureClean(key);
				const phase = `confirm:${viewport}:${slug(name)}:${i}`;
				const page = await measurePage({
					browser,
					site,
					target,
					viewport,
					cookies: target.kind === "admin" && !target.signedOut ? cookies : null,
					options: { ...options, screenshots: false, hold: null },
					phase,
					paths: {},
				});
				ledger.record(key, { observedSql: eventsForPhase(site, phase).map((e) => e.sql) });
				const problems = pageProblems(page, site.origin);
				if (problems.length > 0) {
					out.errors.push({ measurement: `${key} sample ${i + 1}`, error: problems.join("; ") });
				}
				out.pages[key].push({
					cls: page.cls,
					apiCount: page.api.count,
					imageBytes: page.bytesByType?.Image ?? 0,
					oversized: page.oversizedImages.length,
				});
			}
		}
		if (coldStart) {
			await ensureClean("cold start");
			const measured = await measureColdStarts(site, cookies, samples);
			out.coldStart.push(measured);
			for (const [key, sample] of Object.entries(measured)) {
				const bad = sample.samplesStatus?.filter((status) => status >= 400) ?? [];
				if (bad.length > 0) {
					out.errors.push({ measurement: `cold start ${key}`, error: `status ${bad.join(", ")}` });
				}
			}
		}
		const writeArgs = writes ? writeTarget(site, prepared) : null;
		for (let i = 0; i < (writeArgs ? samples : 0); i++) {
			await ensureClean("writes");
			const pass = await measureWrites(site, {
				cookies,
				...writeArgs,
				mediaFile: ctx.scenarioUpload,
				phasePrefix: "confirm-write",
			});
			ledger.record("writes", { declaredWrites: true });
			if (pass.error) out.errors.push({ measurement: `writes sample ${i + 1}`, error: pass.error });
			out.writes.push(pass.ops);
		}
	} finally {
		await site.close();
	}
	return out;
}
