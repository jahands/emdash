#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fileClosure } from "./perf-audit/lib/closure.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultConfig = resolve(repoRoot, "templates/starter-cloudflare/dist/server/wrangler.json");
const configPath = resolve(process.argv[2] ?? defaultConfig);
const maxModules = 30;
const maxBytes = 2_000_000;
const forbiddenSources = [
	{ label: "WordPress WXR importer", pattern: /(?:parse5|cli\/wxr|import\/wxr)/i },
	{ label: "Tiptap or ProseMirror", pattern: /(?:@tiptap|prosemirror)/i },
	{
		label: "plugin registry",
		pattern: /(?:registry-client|registry-moderation|registry-verification)/i,
	},
	{ label: "content media-usage refresh", pattern: /media\/usage\/content-refresh/i },
	{
		label: "media-usage maintenance",
		pattern: /media\/usage\/(?:activation|reconciliation|work)/i,
	},
];

if (!existsSync(configPath)) {
	throw new Error(
		`Worker config not found at ${configPath}. Build the Cloudflare starter template first.`,
	);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
if (typeof config.main !== "string" || config.main.length === 0) {
	throw new Error(`${configPath} does not define a Worker main module.`);
}

const buildRoot = dirname(configPath);
const entry = isAbsolute(config.main) ? config.main : resolve(buildRoot, config.main);
const { files: eagerFiles, bytes: eagerBytes, sourceRegions } = fileClosure(entry, buildRoot);

const forbidden = forbiddenSources.flatMap(({ label, pattern }) => {
	const matches = sourceRegions.filter((source) => pattern.test(source));
	return matches.length > 0 ? [{ label, matches: [...new Set(matches)] }] : [];
});

console.log(`Worker startup closure: ${eagerFiles.length} modules, ${eagerBytes} bytes`);
console.log(`Entry: ${relative(repoRoot, entry)}`);

const failures = [];
if (eagerFiles.length > maxModules) {
	failures.push(`${eagerFiles.length} eager modules exceeds the ${maxModules}-module limit`);
}
if (eagerBytes > maxBytes) {
	failures.push(`${eagerBytes} eager bytes exceeds the ${maxBytes}-byte limit`);
}
for (const group of forbidden) {
	failures.push(
		`${group.label} is statically reachable:\n${group.matches.map((item) => `  ${item}`).join("\n")}`,
	);
}

if (failures.length > 0) {
	console.error(`Worker startup closure check failed:\n${failures.join("\n")}`);
	process.exitCode = 1;
}
