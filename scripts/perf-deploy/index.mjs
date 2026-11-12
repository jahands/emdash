#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent } from "node:https";
import { join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
	completeSetup,
	launchBrowser,
	measurePage,
	seedContent,
	uploadMedia,
	VIEWPORTS,
} from "./browser.mjs";
import { createCloudflareClient, findLeftovers, killChildren, teardownRun } from "./cloudflare.mjs";
import { resolveAuthoritative, timedGet } from "./http.mjs";
import {
	createRunId,
	domainConflict,
	evaluateImages,
	exitCode,
	pageProblems,
	median,
	parseOptions,
	renderSummary,
	resourceNames,
	USAGE,
	UsageError,
} from "./lib.mjs";
import { buildSite, deploySite, prepareSite } from "./site.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const TEMPLATE_DIR = join(ROOT, "templates", "blog-cloudflare");
const WRANGLER_BIN = join(TEMPLATE_DIR, "node_modules", ".bin", "wrangler");
const RUNS_DIR = join(ROOT, ".perf-audit", "deploy");
const WARM_SAMPLES = 5;
const ADMIN_API_PATH = "/_emdash/api/content/posts?limit=20";

const log = (message) => process.stderr.write(`[perf:deploy] ${message}\n`);

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function readRecord(runId) {
	const path = join(RUNS_DIR, runId, "resources.json");
	if (!existsSync(path))
		throw new UsageError(`No resources file for run ${runId} at ${relative(ROOT, path)}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

async function teardownAndVerify(cf, record, recordPath) {
	log(`Tearing down run ${record.runId}`);
	const steps = await teardownRun(cf, record, log);
	const leftovers = await findLeftovers(cf, record);
	const clean = Object.values(leftovers).every((items) => items.length === 0);
	record.teardown = { at: new Date().toISOString(), steps, leftovers, clean };
	writeJson(recordPath, record);
	for (const s of steps) log(`  ${s.kind} ${s.name}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
	log(
		clean
			? "Teardown verified: nothing with the run prefix remains"
			: `Leftovers: ${JSON.stringify(leftovers)}`,
	);
	return record.teardown;
}

async function runTeardownOnly(options) {
	const record = readRecord(options.runId);
	const cf = await createCloudflareClient({
		wranglerBin: WRANGLER_BIN,
		cwd: TEMPLATE_DIR,
		accountId: options.accountId ?? record.accountId,
	});
	if (record.accountId && cf.accountId !== record.accountId) {
		throw new UsageError(
			`Run ${record.runId} was created in account ${record.accountId}, not ${cf.accountId}`,
		);
	}
	const result = await teardownAndVerify(
		cf,
		record,
		join(RUNS_DIR, record.runId, "resources.json"),
	);
	return result.clean ? 0 : 2;
}

/** Wait until the hostname is in the zone and the Worker answers over HTTPS. */
async function waitForHostname(hostname, nameServers, deadlineMs) {
	let ip = null;
	while (Date.now() < deadlineMs) {
		ip = (await resolveAuthoritative(hostname, "A", nameServers).catch(() => []))[0] ?? null;
		if (ip) break;
		await sleep(3000);
	}
	if (!ip) throw new Error(`${hostname} did not resolve before the deadline`);
	let lastError = null;
	while (Date.now() < deadlineMs) {
		try {
			const sample = await timedGet(`https://${hostname}/`, { ip });
			if (sample.status < 500) return { ip, firstResponse: sample };
			lastError = new Error(`status ${sample.status}`);
		} catch (error) {
			lastError = error;
		}
		await sleep(3000);
	}
	throw new Error(`${hostname} did not answer before the deadline: ${lastError?.message}`);
}

/**
 * Sample a logged-out page and an admin API request at the same moment, each
 * on its own new connection, then take warm samples for comparison. Warm
 * samples share one keep-alive connection after a discarded first request, so
 * they reach an isolate that has already served the route; separate
 * connections can land on other machines in the colo and start cold.
 */
async function sampleColdStarts(moment, { origin, ip, cookie }) {
	const targets = [
		{ label: "GET / (logged out)", url: `${origin}/`, headers: {} },
		{
			label: `GET ${ADMIN_API_PATH} (admin)`,
			url: `${origin}${ADMIN_API_PATH}`,
			headers: { Cookie: cookie },
		},
	];
	const cold = await Promise.all(targets.map((t) => timedGet(t.url, { ip, headers: t.headers })));
	const samples = [];
	for (const [index, target] of targets.entries()) {
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		await timedGet(target.url, { ip, headers: target.headers, agent });
		const warm = [];
		for (let i = 0; i < WARM_SAMPLES; i++) {
			warm.push(await timedGet(target.url, { ip, headers: target.headers, agent }));
		}
		agent.destroy();
		samples.push({
			moment,
			label: target.label,
			cold: cold[index],
			warm,
			warmMedianTtfbMs: median(warm.map((sample) => sample.ttfbMs)),
			warmMedianServerMs: median(warm.map((sample) => sample.serverMs)),
		});
		log(
			`${moment}: ${target.label} cold ${cold[index].ttfbMs} ms (${cold[index].status}), warm median ${samples.at(-1).warmMedianTtfbMs} ms`,
		);
	}
	return samples;
}

async function runDeploy(options) {
	const startedAt = new Date();
	const runId = createRunId();
	const names = resourceNames(runId);
	const runDir = join(RUNS_DIR, runId);
	const siteDir = join(runDir, "site");
	const logFile = join(runDir, "commands.log");
	const recordPath = join(runDir, "resources.json");
	mkdirSync(runDir, { recursive: true });

	const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
	const record = {
		runId,
		hostname: options.hostname,
		imageService: options.imageService,
		accountId: options.accountId ?? null,
		createdAt: startedAt.toISOString(),
		resources: {},
	};
	const results = {
		run: {
			runId,
			hostname: options.hostname,
			imageService: options.imageService,
			commit,
			startedAt: startedAt.toISOString(),
			idleGapSeconds: options.idleGapSeconds,
			siteUrlAtBuild: options.siteUrlAtBuild,
		},
		build: null,
		reachability: null,
		setup: null,
		media: [],
		content: null,
		pages: [],
		coldStarts: [],
		errors: [],
		teardown: null,
	};
	const saveRecord = () => writeJson(recordPath, record);
	saveRecord();
	log(`Run ${runId}: output in ${relative(ROOT, runDir)}`);

	let cf = null;
	let browser = null;
	let finished = null;

	const finish = () =>
		(finished ??= (async () => {
			await browser?.close().catch(() => {});
			const finishedAt = new Date();
			results.run.finishedAt = finishedAt.toISOString();
			results.run.durationSeconds = Math.round((finishedAt - startedAt) / 1000);
			writeJson(join(runDir, "results.json"), results);
			writeFileSync(join(runDir, "summary.md"), renderSummary(results));
			if (options.keep) {
				log(
					`--keep: resources left running. Remove them with: pnpm perf:deploy --teardown ${runId}`,
				);
			} else if (cf) {
				try {
					results.teardown = await teardownAndVerify(cf, record, recordPath);
					if (!results.teardown.clean) {
						results.errors.push({
							stage: "teardown",
							message: `Resources remain: ${JSON.stringify(results.teardown.leftovers)}. Retry with: pnpm perf:deploy --teardown ${runId}`,
						});
					}
				} catch (error) {
					results.errors.push({ stage: "teardown", message: String(error?.message ?? error) });
					log(
						`Teardown failed: ${error?.message}. Retry with: pnpm perf:deploy --teardown ${runId}`,
					);
				}
				writeJson(join(runDir, "results.json"), results);
				writeFileSync(join(runDir, "summary.md"), renderSummary(results));
			}
		})());

	let interrupted = false;
	let creating = Promise.resolve();
	/**
	 * Run a step that creates a Cloudflare resource. After an interrupt no new
	 * step starts, and teardown waits for the one in flight so it can delete
	 * what that step created.
	 */
	const create = (fn) => {
		if (interrupted) throw new Error("Interrupted");
		const step = fn();
		creating = step.catch(() => {});
		return step;
	};
	const onSignal = (signal) => {
		if (interrupted) {
			log(`Exiting without finishing teardown. Run: pnpm perf:deploy --teardown ${runId}`);
			process.exit(130);
		}
		interrupted = true;
		log(`${signal} received; stopping and tearing down (press again to abandon teardown)`);
		results.errors.push({ stage: "interrupted", message: `${signal} received` });
		killChildren();
		void creating.then(finish).finally(() => process.exit(130));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	let stage = "preflight";
	try {
		cf = await createCloudflareClient({
			wranglerBin: WRANGLER_BIN,
			cwd: TEMPLATE_DIR,
			accountId: options.accountId,
		});
		record.accountId = cf.accountId;
		saveRecord();

		const zone = await cf.findZone(options.hostname);
		if (!zone) throw new Error(`No zone on account ${cf.accountId} serves ${options.hostname}`);
		const conflict = domainConflict(await cf.listDomains({ hostname: options.hostname }), {
			hostname: options.hostname,
			runId,
		});
		if (conflict) throw new Error(`${conflict}; refusing to replace it`);
		for (const type of ["A", "AAAA", "CNAME"]) {
			const answers = await resolveAuthoritative(options.hostname, type, zone.nameServers);
			if (answers.length > 0)
				throw new Error(
					`${options.hostname} already has ${type} records (${answers.join(", ")}); refusing to replace them`,
				);
		}

		stage = "create resources";
		record.resources.d1 = { name: names.d1 };
		saveRecord();
		record.resources.d1.uuid = (await create(() => cf.createD1(names.d1))).uuid;
		saveRecord();
		record.resources.r2 = { name: names.r2 };
		saveRecord();
		await create(() => cf.createBucket(names.r2));
		record.resources.kv = { name: names.kv };
		saveRecord();
		record.resources.kv.id = (await create(() => cf.createKv(names.kv))).id;
		saveRecord();
		log(`Created D1 ${names.d1}, R2 ${names.r2}, KV ${names.kv}`);

		stage = "build";
		prepareSite({
			templateDir: TEMPLATE_DIR,
			siteDir,
			names,
			d1Id: record.resources.d1.uuid,
			kvId: record.resources.kv.id,
			imageService: options.imageService,
		});
		const buildStarted = Date.now();
		const built = await buildSite({
			siteDir,
			logFile,
			siteUrl: options.siteUrlAtBuild ? `https://${options.hostname}` : undefined,
		});
		const session = built.kv.find((binding) => binding.binding === "SESSION");
		if (built.name !== names.worker || !session?.id || !built.d1[0]?.database_id) {
			throw new Error(
				`Generated Worker config does not use the run's resources: ${JSON.stringify(built)}`,
			);
		}
		results.build = { ms: Date.now() - buildStarted, imagesBinding: built.images };
		log(
			`Built in ${results.build.ms} ms; IMAGES binding: ${built.images ? built.images.binding : "none"}`,
		);

		stage = "deploy";
		record.resources.worker = { name: names.worker };
		saveRecord();
		const deployStarted = Date.now();
		await create(() =>
			deploySite({ siteDir, wranglerBin: WRANGLER_BIN, accountId: cf.accountId, logFile }),
		);
		const deployedAt = Date.now();
		log(`Deployed Worker ${names.worker} in ${deployedAt - deployStarted} ms`);

		stage = "custom domain";
		record.resources.domain = { hostname: options.hostname, zoneId: zone.id };
		saveRecord();
		const domain = await create(() =>
			cf.attachDomain({ hostname: options.hostname, service: names.worker, zoneId: zone.id }),
		);
		record.resources.domain.id = domain.id;
		saveRecord();
		const { ip, firstResponse } = await waitForHostname(
			options.hostname,
			zone.nameServers,
			Date.now() + 10 * 60_000,
		);
		const origin = `https://${options.hostname}`;
		results.reachability = { ip, msFromDeploy: Date.now() - deployedAt, firstResponse };
		log(
			`${origin} answered ${firstResponse.status} via ${ip}, ${results.reachability.msFromDeploy} ms after deploy`,
		);

		stage = "setup";
		browser = await launchBrowser({ hostname: options.hostname, ip });
		const setupStarted = Date.now();
		const owner = await completeSetup(browser, {
			origin,
			email: `owner@${options.hostname}`,
			siteTitle: `EmDash perf ${runId}`,
		});
		results.setup = {
			ms: Date.now() - setupStarted,
			method: "setup wizard + virtual passkey",
			userRole: owner.user?.role ?? null,
		};
		log(`Setup finished in ${results.setup.ms} ms`);

		stage = "seed";
		const uploads = await uploadMedia(owner.page, log);
		results.media = uploads.map(({ item, ...upload }) => ({
			...upload,
			mediaId: item.id,
			storageKey: item.storageKey,
		}));
		results.content = await seedContent(owner.page, uploads, log);
		const storageState = owner.storageState;
		await owner.context.close();
		const cookie = storageState.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

		stage = "cold start after deploy";
		await deploySite({ siteDir, wranglerBin: WRANGLER_BIN, accountId: cf.accountId, logFile });
		results.coldStarts.push(...(await sampleColdStarts("after deploy", { origin, ip, cookie })));

		stage = "measure pages";
		const newest = results.content.newest;
		const pages = [
			{
				name: "Admin media library",
				path: "/_emdash/admin/media",
				admin: true,
				expect: { selector: "main", minMedia: uploads.length },
			},
			{
				name: "Admin editor",
				path: `/_emdash/admin/content/posts/${newest.id}`,
				admin: true,
				expect: { selector: "main", minMedia: 1 },
			},
			{ name: "Home", path: "/", admin: false, expect: { selector: "main", minMedia: 1 } },
			{
				name: "Entry",
				path: `/posts/${newest.slug}`,
				admin: false,
				expect: { selector: "main", minMedia: 1 + newest.bodyImages },
			},
		];
		for (const viewportName of Object.keys(VIEWPORTS)) {
			for (const page of pages) {
				const measured = await measurePage(browser, {
					origin,
					name: page.name,
					path: page.path,
					viewportName,
					storageState: page.admin ? storageState : undefined,
					outDir: runDir,
					expect: page.expect,
				});
				const { images, failures } = evaluateImages(measured.images);
				const evaluated = { ...measured, images };
				results.pages.push(evaluated);
				const problems = pageProblems(evaluated);
				log(
					`${page.name} (${viewportName}): status ${measured.status}, ${images.length} images, ${failures.length} failing${problems.length > 0 ? `; ${problems.join("; ")}` : ""}`,
				);
			}
		}

		stage = "cold start after idle";
		log(`Idling ${options.idleGapSeconds} s before the idle cold-start sample`);
		await sleep(options.idleGapSeconds * 1000);
		results.coldStarts.push(
			...(await sampleColdStarts(`after ${options.idleGapSeconds} s idle`, { origin, ip, cookie })),
		);
	} catch (error) {
		if (!interrupted) {
			results.errors.push({ stage, message: String(error?.message ?? error) });
			log(`Failed during ${stage}: ${error?.stack ?? error}`);
		}
	} finally {
		await finish();
	}

	log(`Results: ${relative(ROOT, join(runDir, "summary.md"))}`);
	return exitCode(results);
}

async function main() {
	try {
		const options = parseOptions(process.argv.slice(2));
		if (options.mode === "help") {
			process.stdout.write(USAGE);
			return 0;
		}
		if (options.mode === "teardown") return await runTeardownOnly(options);
		return await runDeploy(options);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		process.stderr.write(`${error.message}\n\n${USAGE}`);
		return 64;
	}
}

process.exitCode = await main();
