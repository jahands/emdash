import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAdminDist } from "../../../../src/astro/integration/vite-config.js";

const STATIC_IMPORT =
	/(?:^|[\s;])(?:import|export)\s*(?:[^"';]*?\sfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
const APP_IMPORT = /import\s*\{[^}]*\bas AdminApp\b[^}]*\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/;

const SERVER_ENTRIES = [
	"locales/index.js",
	"locales/config.js",
	"locales/server.js",
	"locales/emails.js",
	"slugify.js",
	"html-block.js",
	"portable-text-table.js",
];

function staticImports(dist: string, file: string): string[] {
	const source = readFileSync(join(dist, file), "utf8");
	return Array.from(source.matchAll(STATIC_IMPORT), (match) =>
		normalize(join(dirname(file), match[1]!)),
	);
}

function staticClosure(dist: string, entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		pending.push(...staticImports(dist, file));
	}
	return seen;
}

describe("admin server entries", () => {
	// EmDash core imports these on the server. If one statically reaches the
	// admin app's chunk, every site's server bundle carries the whole admin SPA.
	it.each(SERVER_ENTRIES)("%s does not load the admin app", (entry) => {
		const dist = resolveAdminDist();
		const appSource = readFileSync(join(dist, "app-entry.js"), "utf8");
		const appChunk = APP_IMPORT.exec(appSource)?.[1];
		expect(appChunk).toBeDefined();

		expect(staticClosure(dist, entry)).not.toContain(normalize(appChunk!));
	});
});
