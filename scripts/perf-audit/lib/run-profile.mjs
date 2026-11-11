/**
 * Run every measurement for one profile, restoring the seeded snapshot
 * whenever a previous measurement wrote state.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { measureBuildOutput, measureInitialAdminJs } from "./build-output.mjs";
import { measureColdStarts } from "./cold-start.mjs";
import { RestoreLedger } from "./ledger.mjs";
import { measurePage } from "./page-run.mjs";
import { prepareProfile, SEEDED } from "./prepare.mjs";
import { runScenarios } from "./scenarios.mjs";
import { planOwnerEdits } from "./seed.mjs";
import { eventsForPhase, serverPass } from "./server-pass.mjs";
import { buildTargets, filterTargets } from "./targets.mjs";

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

function discoverTargets(site, prepared) {
	const seed = JSON.parse(readFileSync(join(site.siteDir, "seed/seed.json"), "utf8"));
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

export async function runProfile(ctx) {
	const { browser, profile, workspace, options, log, resultsDir } = ctx;
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
			seed: prepared.seed,
		},
		asShipped: prepared.asShipped ?? [],
		pages: [],
		scenarios: [],
		errors: [],
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
		result.build = measureBuildOutput(site, ctx.dirs.scratch);
		result.initialAdminJs = await measureInitialAdminJs(site, cookies);
		log(
			`  build: server ${(result.build.server.gzipBytes / 1024).toFixed(0)} KiB gzip, admin initial JS ${(result.initialAdminJs.gzipBytes / 1024).toFixed(0)} KiB gzip`,
		);

		const targets = filterTargets(discoverTargets(site, prepared), options.only);
		const passCache = new Map();
		const pixelCache = new Map();
		for (const viewport of options.viewports) {
			for (const target of targets) {
				const name = `${viewport} ${target.name}`;
				const phase = `page:${viewport}:${slug(target.name)}`;
				const shotBase = join(resultsDir, "screenshots", profile.id, viewport, slug(target.name));
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
					for (const r of page.serverPass) delete r.sql;
					result.pages.push({ name: target.name, kind: target.kind, viewport, ...page });
					log(
						`  ${viewport.padEnd(7)} ${target.name.padEnd(34)} CLS ${page.cls.toFixed(3)}  LCP ${page.lcpMs ?? "-"} ms  API ${page.api.count}  oversized ${page.oversizedImages.length}`,
					);
				} catch (error) {
					result.errors.push({
						measurement: name,
						error: String(error?.stack ?? error).slice(0, 800),
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
				cookies,
				options,
				prepared,
				targets,
				ledger,
				ensureClean,
				log,
				mediaFile: ctx.scenarioUpload,
				screenshotDir: join(resultsDir, "screenshots", profile.id, "scenarios"),
			});
		}

		if (!options.skipColdStart) {
			try {
				await ensureClean("cold start");
				result.coldStart = await measureColdStarts(site, cookies);
				log(
					`  cold start: public ${result.coldStart.publicPage.ttfbMs} ms, admin API ${result.coldStart.adminApi.ttfbMs} ms`,
				);
			} catch (error) {
				result.errors.push({ measurement: "cold start", error: String(error).slice(0, 800) });
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
		result.seconds = Math.round((Date.now() - startedAt) / 1000);
		await site.close();
	}
	return result;
}

/**
 * Measure some screens and the cold starts again, `samples` times each, on
 * the site this run prepared. Compare uses it to confirm a regression
 * before reporting it, because layout races and cold starts vary between
 * runs of the same code.
 */
export async function remeasureProfile(ctx, { pages, coldStart, samples }) {
	const { browser, options } = ctx;
	const { site, cookies, prepared } = await prepareProfile({
		...ctx,
		options: { ...options, reuse: true },
	});
	const ledger = new RestoreLedger(SEEDED);
	const out = { pages: {}, coldStart: [] };
	const warm = () =>
		fetch(`${site.origin}/`, { headers: { "x-perf-phase": "warm-up" } }).then((r) =>
			r.arrayBuffer(),
		);
	const ensureClean = async (name) => {
		await site.ensureRunning();
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
			if (!target) continue;
			const key = `${viewport} ${name}`;
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
			out.coldStart.push(await measureColdStarts(site, cookies, samples));
		}
	} finally {
		await site.close();
	}
	return out;
}
