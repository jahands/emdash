/**
 * Derives the audited URL list from the admin router and the fixture's page
 * files, so a new route is measured or reported instead of silently skipped.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ROUTER_PATH = join(ROOT, "packages/admin/src/router.tsx");
const PUBLIC_PAGES_DIR = join(ROOT, "fixtures/perf-site/src/pages");

const ASTRO_EXTENSION = /\.astro$/;
const INDEX_SUFFIX = /\/index$/;
const ROUTE_PATTERN =
	/const\s+\w+\s*=\s*createRoute\(\{\s*getParentRoute:\s*\(\)\s*=>\s*(\w+),\s*(?:id:\s*"[^"]*",\s*)?path:\s*"([^"]+)"/g;

const ADMIN_PARAM_VALUES = {
	"/content/$collection": () => ["/content/posts", "/content/pages", "/content/products"],
	"/content/$collection/new": () => ["/content/posts/new", "/content/products/new"],
	"/content/$collection/$id": ({ shortPostId, longPostId, productId }) => [
		{ label: "/content/posts/$id(short)", path: `/content/posts/${shortPostId}` },
		{ label: "/content/posts/$id(long)", path: `/content/posts/${longPostId}` },
		{ label: "/content/products/$id", path: `/content/products/${productId}` },
	],
	"/menus/$name": () => ["/menus/primary", "/menus/footer"],
	"/taxonomies/$taxonomy": () => ["/taxonomies/category", "/taxonomies/tag"],
	"/sections/$slug": ({ sectionSlug }) => [`/sections/${sectionSlug}`],
	"/content-types/$slug": () => ["/content-types/posts"],
};

const PUBLIC_PARAM_VALUES = {
	"/posts/[slug]": () => ["/posts/building-for-the-long-term", "/posts/the-long-read"],
	"/pages/[slug]": () => ["/pages/about"],
	"/category/[slug]": () => ["/category/development"],
	"/tag/[slug]": () => ["/tag/webdev"],
	"/search": () => ["/search?q=static"],
	"/404": () => ["/this-page-does-not-exist"],
};

function walkPages(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walkPages(path));
		else if (entry.name.endsWith(".astro")) files.push(path);
	}
	return files;
}

function publicPatternFor(file) {
	const path = `/${relative(PUBLIC_PAGES_DIR, file)
		.split(sep)
		.join("/")
		.replace(ASTRO_EXTENSION, "")}`;
	const normalized = path.replace(INDEX_SUFFIX, "");
	return normalized === "" ? "/" : normalized;
}

export function discoverTargets(params) {
	const targets = [];
	const unreachable = [];

	for (const [, parent, pattern] of readFileSync(ROUTER_PATH, "utf8").matchAll(ROUTE_PATTERN)) {
		if (pattern === "$") continue;
		const auth = parent === "adminLayoutRoute";
		const prefix = auth ? "admin" : "auth";
		const paths = pattern.includes("$") ? ADMIN_PARAM_VALUES[pattern]?.(params) : [pattern];
		if (!paths) {
			unreachable.push({
				pattern: `${prefix}:${pattern}`,
				reason: "no seeded value for its parameters",
			});
			continue;
		}
		for (const entry of paths) {
			const { label, path } = typeof entry === "string" ? { label: entry, path: entry } : entry;
			targets.push({
				id: `${prefix}:${label}`,
				pattern,
				url: `/_emdash/admin${path}`,
				kind: "route",
				auth,
			});
		}
	}

	for (const file of walkPages(PUBLIC_PAGES_DIR)) {
		const pattern = publicPatternFor(file);
		const paths =
			PUBLIC_PARAM_VALUES[pattern]?.() ?? (pattern.includes("[") ? undefined : [pattern]);
		if (!paths) {
			unreachable.push({
				pattern: `public:${pattern}`,
				reason: "no seeded value for its parameters",
			});
			continue;
		}
		for (const path of paths) {
			targets.push({
				id: `public:${path}`,
				fixtureOnly: path.includes("contributors-naive") || path.startsWith("/related"),
				pattern,
				url: path,
				kind: "route",
				auth: false,
			});
		}
	}

	return { targets, unreachable };
}
