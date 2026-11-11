/**
 * Prepare a profile: materialize the site, build it, seed it and snapshot
 * the seeded state every measurement starts from.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { materializeSite, resolvePackageDir } from "./materialize.mjs";
import { seedSite, signIn } from "./seed.mjs";
import { Site } from "./site.mjs";

export const SEEDED = "seeded";
const PREPARED_VERSION = 1;

function workspaceRevision(workspace) {
	try {
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
		const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
			cwd: workspace,
			encoding: "utf8",
		});
		return { head: head.trim(), dirty: dirty.trim().length > 0 };
	} catch {
		return { head: "unknown", dirty: true };
	}
}

function extraPackages(workspace, profile) {
	const templateModules = resolve(workspace, "templates", profile.sourceTemplate, "node_modules");
	const extras = {};
	if (profile.runtime === "node") {
		// npm hoists astro's sharp dependency into a site's node_modules; the
		// pnpm-linked template does not, and the Node image endpoint needs it.
		extras.sharp = resolvePackageDir(join(templateModules, "astro"), "sharp");
	}
	if (profile.database === "postgres") {
		extras.pg = resolvePackageDir(resolve(workspace, "packages/core"), "pg");
	}
	return extras;
}

export async function prepareProfile(args) {
	const holder = {};
	try {
		return await prepareProfileInner(args, holder);
	} catch (error) {
		await holder.site?.close();
		throw error;
	}
}

async function prepareProfileInner(
	{ browser, profile, workspace, dirs, pg, options, mediaFiles, log, label },
	holder,
) {
	const siteDir = join(dirs.sites, profile.id);
	const site = new Site({
		profile,
		siteDir,
		stateDir: join(dirs.state, profile.id),
		logDir: dirs.logs,
		pg,
		dbLatencyMs: options.dbLatency,
		label,
	});
	holder.site = site;
	const revision = workspaceRevision(workspace);
	const markerPath = join(site.stateDir, "prepared.json");
	const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, "utf8")) : null;
	const reusable =
		options.reuse &&
		marker?.version === PREPARED_VERSION &&
		marker.workspace === workspace &&
		marker.revision.head === revision.head;

	if (reusable) {
		const note = revision.dirty ? "; the workspace has uncommitted changes" : "";
		log(`  reusing the prepared site (${revision.head.slice(0, 9)}${note})`);
		await site.restore(SEEDED);
		await site.start();
		return { site, cookies: marker.cookies, prepared: marker, reused: true };
	}

	const { changed, templateDir } = materializeSite({
		workspace,
		profile,
		siteDir,
		postgresUrl: profile.usesPostgres ? site.postgresUrl : undefined,
		extraPackages: extraPackages(workspace, profile),
	});
	log(`  materialized from ${templateDir} (changed: ${changed.join(", ")})`);
	await site.startProxy();
	// Seeding is setup, not measurement: it runs without added latency.
	site.proxy?.setLatency(0);
	const build = site.build();
	log(`  built in ${(build.buildMs / 1000).toFixed(1)}s`);
	await site.resetState();
	await site.start();
	const seed = await seedSite({ browser, site, mediaFiles, log });
	// The measurement session is part of the snapshot, so restores keep it valid.
	const cookies = await signIn(site);
	await site.stop();
	await site.snapshot(SEEDED);
	site.proxy?.setLatency(options.dbLatency);
	await site.start();
	const prepared = {
		version: PREPARED_VERSION,
		workspace,
		revision,
		changedFiles: changed,
		build,
		seed,
		cookies,
	};
	writeFileSync(markerPath, JSON.stringify(prepared, null, "\t"));
	return { site, cookies, prepared, reused: false };
}
