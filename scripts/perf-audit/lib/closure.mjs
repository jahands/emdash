/**
 * Static import closures of built JavaScript: what loads before any dynamic
 * import runs.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'();=]*?\bfrom\s*)?["']([^"']+)["']/g;
const SOURCE_REGION = /^\/\/#region (.+)$/gm;
const MODULE_SCRIPT = /<script\b[^>]*\btype=["']module["'][^>]*>/gi;
const MODULEPRELOAD = /<link\b[^>]*\brel=["']modulepreload["'][^>]*>/gi;
const ASTRO_ISLAND = /<astro-island\b[^>]*?(?=\sprops=|>)/gi;
const SRC_ATTR = /\bsrc=["']([^"']+)["']/i;
const HREF_ATTR = /\bhref=["']([^"']+)["']/i;
const ISLAND_ATTRS = ["component-url", "renderer-url", "before-hydration-url"].map(
	(attr) => new RegExp(`\\s${attr}=["']([^"']+)["']`, "i"),
);

export function staticSpecifiers(source) {
	STATIC_IMPORT.lastIndex = 0;
	return Array.from(source.matchAll(STATIC_IMPORT), (m) => m[1]);
}

/** Relative static-import closure of an entry file on disk, kept inside `root`. */
export function fileClosure(entry, root = dirname(entry)) {
	const modules = new Set();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop();
		if (!file || modules.has(file) || !existsSync(file)) continue;
		modules.add(file);
		for (const specifier of staticSpecifiers(readFileSync(file, "utf8"))) {
			if (!specifier.startsWith(".")) continue;
			const dependency = resolve(dirname(file), specifier);
			if (dependency.startsWith(root)) pending.push(dependency);
		}
	}
	const files = [...modules];
	const sourceRegions = [];
	for (const file of files) {
		SOURCE_REGION.lastIndex = 0;
		for (const match of readFileSync(file, "utf8").matchAll(SOURCE_REGION)) {
			if (match[1]) sourceRegions.push(match[1]);
		}
	}
	return {
		files,
		bytes: files.reduce((sum, f) => sum + statSync(f).size, 0),
		gzipBytes: files.reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0),
		sourceRegions,
	};
}

/**
 * JavaScript a document loads on its own: module scripts, modulepreload
 * links, and the component and renderer modules of Astro islands.
 */
export function documentModuleScripts(html, baseUrl) {
	const urls = new Set();
	const add = (value) => urls.add(new URL(value.replaceAll("&amp;", "&"), baseUrl).toString());
	for (const m of html.matchAll(MODULE_SCRIPT)) {
		const src = SRC_ATTR.exec(m[0]);
		if (src) add(src[1]);
	}
	for (const m of html.matchAll(MODULEPRELOAD)) {
		const href = HREF_ATTR.exec(m[0]);
		if (href) add(href[1]);
	}
	for (const m of html.matchAll(ASTRO_ISLAND)) {
		for (const pattern of ISLAND_ATTRS) {
			const value = pattern.exec(m[0]);
			if (value) add(value[1]);
		}
	}
	return [...urls];
}

/**
 * Static import closure starting from a document's module scripts, fetched
 * over HTTP so it reflects what the runtime serves.
 */
export async function httpClosure(entryUrls, { headers = {} } = {}) {
	const seen = new Map();
	const pending = [...entryUrls];
	while (pending.length > 0) {
		const url = pending.pop();
		if (seen.has(url)) continue;
		const response = await fetch(url, { headers });
		const body = Buffer.from(await response.arrayBuffer());
		seen.set(url, {
			bytes: body.length,
			gzipBytes: gzipSync(body).length,
			status: response.status,
		});
		if (!response.ok) continue;
		for (const specifier of staticSpecifiers(body.toString("utf8"))) {
			if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
			pending.push(new URL(specifier, url).toString());
		}
	}
	const files = Array.from(seen.entries(), ([url, info]) => ({ url, ...info }));
	return {
		files: files.length,
		bytes: files.reduce((sum, f) => sum + f.bytes, 0),
		gzipBytes: files.reduce((sum, f) => sum + f.gzipBytes, 0),
		largest: files.toSorted((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 5),
	};
}
