/**
 * Materialize a profile's site from a shipped template.
 *
 * Only platform settings change: adapter options, database, `siteUrl`, the
 * image service and the matching wrangler bindings. Pages, layouts,
 * components and seed are copied unchanged.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const COPY_EXCLUDES = new Set([
	"node_modules",
	"dist",
	".astro",
	".wrangler",
	"uploads",
	"data.db",
	"data.db-wal",
	"data.db-shm",
]);

export const HYPERDRIVE_BINDING = "HYPERDRIVE";
const SQLITE_DATABASE = /database:\s*sqlite\(\{[^}]*\}\)/;
const D1_DATABASE = /database:\s*d1\(\{[^}]*\}\)/;
const D1_IMPORT = /import \{ d1, r2 \} from "@emdash-cms\/cloudflare";/;
const TRAILING_COMMA = /,(\s*[}\]])/g;

function replaceOnce(source, search, replacement, what) {
	const count = source.split(search).length - 1;
	if (count !== 1) {
		throw new Error(
			`Cannot materialize ${what}: expected exactly one ${JSON.stringify(search)} in astro.config.mjs, found ${count}.`,
		);
	}
	return source.replace(search, replacement);
}

function replacePattern(source, pattern, replacement, what) {
	const matches = source.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
	if (matches?.length !== 1) {
		throw new Error(
			`Cannot materialize ${what}: expected exactly one match for ${pattern} in astro.config.mjs, found ${matches?.length ?? 0}.`,
		);
	}
	return source.replace(pattern, replacement);
}

/**
 * Rewrite a template's astro.config.mjs for a profile. Throws when the
 * template no longer has the shape this expects, so a template change
 * surfaces as a harness error instead of a silently different site.
 */
export function transformAstroConfig(source, profile, { postgresUrl } = {}) {
	let out = replaceOnce(
		source,
		"emdash({",
		`emdash({\n\t\t\tsiteUrl: ${JSON.stringify(profile.origin)},`,
		"siteUrl",
	);

	if (profile.database === "postgres") {
		if (!postgresUrl) throw new Error("node-postgres profiles need a postgresUrl");
		out = replaceOnce(
			out,
			'import { sqlite } from "emdash/db";',
			'import { postgres } from "emdash/db";',
			"the postgres import",
		);
		out = replacePattern(
			out,
			SQLITE_DATABASE,
			`database: postgres({ connectionString: ${JSON.stringify(postgresUrl)} })`,
			"the postgres database",
		);
	}

	if (profile.database === "hyperdrive") {
		out = replacePattern(
			out,
			D1_IMPORT,
			'import { hyperdrive, r2 } from "@emdash-cms/cloudflare";',
			"the hyperdrive import",
		);
		out = replacePattern(
			out,
			D1_DATABASE,
			`database: hyperdrive({ binding: ${JSON.stringify(HYPERDRIVE_BINDING)} })`,
			"the hyperdrive database",
		);
	}

	if (profile.images === "url") {
		out = replaceOnce(
			out,
			"adapter: cloudflare(),",
			'adapter: cloudflare({ imageService: "cloudflare" }),',
			"the URL image service",
		);
	}

	return out;
}

/** Strip comments and trailing commas so JSONC parses as JSON. */
export function parseJsonc(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i++;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else {
			out += ch;
		}
	}
	return JSON.parse(out.replace(TRAILING_COMMA, "$1"));
}

/**
 * Rewrite a template's wrangler config for a profile. Local D1 needs a
 * database id; Hyperdrive replaces D1 with a binding whose
 * `localConnectionString` points at the latency proxy.
 */
export function transformWranglerConfig(config, profile, { postgresUrl } = {}) {
	const out = structuredClone(config);
	delete out.$schema;
	if (profile.database === "hyperdrive") {
		if (!postgresUrl) throw new Error("workerd-postgres profiles need a postgresUrl");
		delete out.d1_databases;
		out.hyperdrive = [
			{ binding: HYPERDRIVE_BINDING, id: "perf-audit-local", localConnectionString: postgresUrl },
		];
	} else {
		out.d1_databases = (out.d1_databases ?? []).map((db) => ({
			...db,
			database_id: db.database_id ?? "perf-audit-local",
		}));
	}
	return out;
}

/**
 * Give the site a node_modules of links into the workspace template's own
 * dependencies, so it builds against that workspace's packages.
 */
function linkDependencies(siteDir, templateDir, extraPackages) {
	const templateModules = join(templateDir, "node_modules");
	if (!existsSync(templateModules)) {
		throw new Error(
			`${templateModules} is missing. Run pnpm install in the workspace before running the audit.`,
		);
	}
	const target = join(siteDir, "node_modules");
	mkdirSync(target, { recursive: true });
	const link = (name, from) => {
		const dest = join(target, name);
		if (name.includes("/")) mkdirSync(join(target, name.split("/")[0]), { recursive: true });
		if (!existsSync(dest)) symlinkSync(realpathSync(from), dest, "dir");
	};
	for (const entry of readdirSync(templateModules)) {
		if (entry.startsWith(".")) {
			if (entry === ".bin") {
				cpSync(join(templateModules, ".bin"), join(target, ".bin"), {
					recursive: true,
					verbatimSymlinks: true,
				});
			}
			continue;
		}
		if (entry.startsWith("@")) {
			for (const scoped of readdirSync(join(templateModules, entry))) {
				link(`${entry}/${scoped}`, join(templateModules, entry, scoped));
			}
		} else {
			link(entry, join(templateModules, entry));
		}
	}
	for (const [name, from] of Object.entries(extraPackages)) link(name, from);
}

/** Directory of `name` as resolved from the package at `fromDir`. */
export function resolvePackageDir(fromDir, name) {
	const require = createRequire(join(realpathSync(fromDir), "package.json"));
	let dir = dirname(require.resolve(name));
	while (dirname(dir) !== dir) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name)
			return dir;
		dir = dirname(dir);
	}
	throw new Error(`Cannot find the package directory of ${name} from ${fromDir}`);
}

export const SOURCE_CONFIG = "perf-audit.astro.config.mjs";

/**
 * The site's astro.config.mjs: the profile's config with hidden source
 * maps turned on. Hidden maps leave the emitted code unchanged, without
 * even a `sourceMappingURL` comment, and let the harness attribute bundle
 * bytes to packages and modules.
 */
export function sourceMapConfig(sourceFile = SOURCE_CONFIG) {
	return `import config from "./${sourceFile}";

export default {
	...config,
	vite: { ...config.vite, build: { ...config.vite?.build, sourcemap: "hidden" } },
};
`;
}

/**
 * Copy the template into `siteDir` and apply the profile's platform changes.
 * Returns the list of files that differ from the template.
 */
export function materializeSite({ workspace, profile, siteDir, postgresUrl, extraPackages = {} }) {
	const templateDir = resolve(workspace, "templates", profile.sourceTemplate);
	if (!existsSync(templateDir)) throw new Error(`Template not found: ${templateDir}`);

	rmSync(siteDir, { recursive: true, force: true });
	mkdirSync(siteDir, { recursive: true });
	for (const entry of readdirSync(templateDir)) {
		if (COPY_EXCLUDES.has(entry)) continue;
		cpSync(join(templateDir, entry), join(siteDir, entry), { recursive: true });
	}

	const changed = ["astro.config.mjs", SOURCE_CONFIG];
	const configPath = join(siteDir, "astro.config.mjs");
	writeFileSync(
		join(siteDir, SOURCE_CONFIG),
		transformAstroConfig(readFileSync(configPath, "utf8"), profile, { postgresUrl }),
	);
	writeFileSync(configPath, sourceMapConfig());

	const wranglerPath = join(siteDir, "wrangler.jsonc");
	if (profile.runtime === "workerd") {
		const config = transformWranglerConfig(
			parseJsonc(readFileSync(wranglerPath, "utf8")),
			profile,
			{ postgresUrl },
		);
		writeFileSync(wranglerPath, JSON.stringify(config, null, "\t") + "\n");
		changed.push("wrangler.jsonc");
	}

	linkDependencies(siteDir, templateDir, extraPackages);
	return { templateDir, changed };
}
