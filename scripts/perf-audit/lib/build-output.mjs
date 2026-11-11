/**
 * Build output per profile: the server bundle (for workerd, what wrangler
 * would upload), the client assets, the server startup closure and the
 * admin's initial JavaScript.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

import { cookieHeader } from "./auth.mjs";
import { documentModuleScripts, fileClosure, httpClosure } from "./closure.mjs";
import { run } from "./proc.mjs";

function walk(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(path));
		else if (entry.isFile()) out.push(path);
	}
	return out;
}

function sizeOf(files) {
	return {
		files: files.length,
		bytes: files.reduce((sum, f) => sum + statSync(f).size, 0),
		gzipBytes: files.reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0),
	};
}

const isMap = (f) => f.endsWith(".map");
const LOCALE_CATALOG = /packages\/admin\/dist\/messages-/;
const NODE_MODULES_PACKAGE = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/;
const WORKSPACE_PACKAGE = /(?:^|\/)packages\/((?:plugins\/)?[^/]+)/;
const TOTAL_UPLOAD = /Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/;
const JS_FILE = /\.m?js$/;
const REGION_BLOCK = /^\/\/#region (.+)$([\s\S]*?)^\/\/#endregion/gm;

/** Package name for a rolldown `//#region` source path. */
export function regionPackage(source) {
	if (LOCALE_CATALOG.test(source)) return "packages/admin (locale catalogs)";
	const modules = NODE_MODULES_PACKAGE.exec(source);
	if (modules) return modules[1];
	const workspace = WORKSPACE_PACKAGE.exec(source);
	if (workspace) return `packages/${workspace[1]}`;
	return "(site)";
}

/** Bytes per source package, from the region markers in built files. */
export function bytesByPackage(sources) {
	const totals = new Map();
	for (const text of sources) {
		for (const match of text.matchAll(REGION_BLOCK)) {
			const name = regionPackage(match[1]);
			totals.set(name, (totals.get(name) ?? 0) + Buffer.byteLength(match[2]));
		}
	}
	return Array.from(totals.entries(), ([name, bytes]) => ({ package: name, bytes })).toSorted(
		(a, b) => b.bytes - a.bytes,
	);
}

/** Bytes wrangler reports for `deploy --dry-run`, without contacting Cloudflare. */
function wranglerDryRun(site, outDir) {
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });
	const config = join(site.siteDir, "dist/server/wrangler.json");
	const wrangler = join(site.siteDir, "node_modules/wrangler/bin/wrangler.js");
	const result = run(
		process.execPath,
		[wrangler, "deploy", "--dry-run", "--config", config, "--outdir", outDir],
		{
			cwd: site.siteDir,
			logStream: site.log,
			allowFailure: true,
			env: { WRANGLER_SEND_METRICS: "false" },
		},
	);
	const output = `${result.stdout}${result.stderr}`;
	const match = TOTAL_UPLOAD.exec(output);
	const files = walk(outDir).filter((f) => !isMap(f));
	return {
		ok: result.status === 0,
		uploadBytes: match ? Math.round(Number(match[1]) * 1024) : null,
		uploadGzipBytes: match ? Math.round(Number(match[2]) * 1024) : null,
		files: files.length,
		error: result.status === 0 ? null : output.split("\n").slice(-8).join("\n"),
	};
}

export function measureBuildOutput(site, scratchDir) {
	const serverDir = join(site.siteDir, "dist/server");
	const clientDir = join(site.siteDir, "dist/client");
	const serverFiles = walk(serverDir).filter((f) => !isMap(f));
	const server = sizeOf(serverFiles);
	const client = sizeOf(walk(clientDir).filter((f) => !isMap(f)));

	let entry = join(serverDir, "entry.mjs");
	if (site.profile.runtime === "workerd") {
		const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8"));
		entry = join(serverDir, config.main);
	}
	const closure = fileClosure(entry, serverDir);
	const out = {
		server: {
			files: server.files,
			bytes: server.bytes,
			gzipBytes: server.gzipBytes,
			largest: serverFiles
				.map((f) => ({ file: relative(serverDir, f), bytes: statSync(f).size }))
				.toSorted((a, b) => b.bytes - a.bytes)
				.slice(0, 5),
		},
		packages: bytesByPackage(
			serverFiles.filter((f) => JS_FILE.test(f)).map((f) => readFileSync(f, "utf8")),
		).slice(0, 12),
		clientAssets: { files: client.files, bytes: client.bytes, gzipBytes: client.gzipBytes },
		startupClosure: {
			modules: closure.files.length,
			bytes: closure.bytes,
			gzipBytes: closure.gzipBytes,
		},
	};
	if (site.profile.runtime === "workerd") {
		out.upload = wranglerDryRun(site, join(scratchDir, `${site.profile.id}-upload`));
	}
	return out;
}

/** Gzip size of the admin document's static module-script closure. */
export async function measureInitialAdminJs(site, cookies) {
	const headers = cookies ? { Cookie: cookieHeader(cookies) } : {};
	const response = await fetch(`${site.origin}/_emdash/admin/`, { headers });
	const html = await response.text();
	const entries = documentModuleScripts(html, `${site.origin}/_emdash/admin/`);
	return {
		documentBytes: Buffer.byteLength(html),
		documentGzipBytes: gzipSync(html).length,
		entries,
		...(await httpClosure(entries, { headers })),
	};
}
