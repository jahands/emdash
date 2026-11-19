/**
 * Packages the harness links into a site that the template itself should
 * provide. The link keeps measurements running; this check reports when a
 * site installed from the template as shipped could not load them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SCRIPT = /\.m?js$/;
const ESCAPE = /[.*+?^${}()|[\]\\/]/g;

function importPattern(name) {
	const quoted = `["']${name.replace(ESCAPE, "\\$&")}(?:/[^"']*)?["']`;
	return new RegExp(
		`(?:\\bimport\\s*\\(\\s*|\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)${quoted}`,
	);
}

function walk(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return walk(path);
		return entry.isFile() && SCRIPT.test(entry.name) ? [path] : [];
	});
}

/** Files under `serverDir` that import `name`. */
export function importersOf(serverDir, name) {
	const pattern = importPattern(name);
	return walk(serverDir)
		.filter((file) => pattern.test(readFileSync(file, "utf8")))
		.map((file) => relative(serverDir, file));
}

function declares(templateDir, name) {
	const manifest = JSON.parse(readFileSync(join(templateDir, "package.json"), "utf8"));
	return ["dependencies", "optionalDependencies", "peerDependencies"].some(
		(field) => manifest[field]?.[name] !== undefined,
	);
}

/**
 * Whether `name` is in the template root's own node_modules. Resolving
 * normally would also search the monorepo root, which a site does not have.
 */
function resolvesFrom(templateDir, name) {
	return existsSync(join(templateDir, "node_modules", name, "package.json"));
}

/** A product finding when the built server needs a package the template cannot resolve. */
export function asShippedFinding({ name, template, importers, declared, resolvable }) {
	if (importers.length === 0 || resolvable) return null;
	const why = declared
		? "it is not installed in the template's node_modules"
		: "the template does not declare it, so a strict install (pnpm) leaves it out and only npm's hoisting of another package's copy would provide it";
	return `The ${template} template's built server imports \`${name}\` (${importers.slice(0, 2).join(", ")}), but ${why}. The harness linked it so the measurements could run.`;
}

/**
 * Check each package the harness linked for the template's own runtime.
 * `templateDir` is the template as installed in the workspace; under pnpm
 * it resolves only what it declares.
 */
export function checkAsShipped({ template, templateDir, serverDir, packages }) {
	return packages.map((name) => {
		const importers = importersOf(serverDir, name);
		const declared = declares(templateDir, name);
		const resolvable = resolvesFrom(templateDir, name);
		return {
			package: name,
			importers: importers.slice(0, 5),
			declared,
			resolvable,
			linkedByHarness: true,
			finding: asShippedFinding({ name, template, importers, declared, resolvable }),
		};
	});
}
