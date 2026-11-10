import { fileURLToPath } from "node:url";

import { transformAsync } from "@babel/core";
import type { ManualChunksFunction, Plugin } from "rolldown";
import { defineConfig } from "tsdown";

const JS_TS_RE = /\.[jt]sx?$/;
const LOCALE_CATALOG_RE = /[/\\]src[/\\]locales[/\\]([^/\\]+)[/\\]messages\.mjs$/;

const APP_ENTRY = fileURLToPath(new URL("./src/app-entry.ts", import.meta.url));
const INDEPENDENT_ENTRIES = [
	"locales/index",
	"locales/server",
	"locales/config",
	"locales/emails",
	"slugify",
	"html-block",
	"portable-text-table",
].map((path) => fileURLToPath(new URL(`./src/${path}.ts`, import.meta.url)));

type ModuleInfoGetter = Parameters<ManualChunksFunction>[1]["getModuleInfo"];

function staticModuleGraph(entries: string[], getModuleInfo: ModuleInfoGetter) {
	const modules = new Set<string>();
	const pending = [...entries];
	while (pending.length > 0) {
		const id = pending.pop()!;
		if (modules.has(id)) continue;
		const info = getModuleInfo(id);
		if (!info || info.isExternal) continue;
		modules.add(id);
		pending.push(...info.importedIds);
	}
	return modules;
}

function adminShellPlugin(): Plugin {
	let shellModules = new Set<string>();
	return {
		name: "emdash-admin-shell-chunks",
		buildEnd(error) {
			shellModules = new Set();
			if (error) return;
			const getModuleInfo: ModuleInfoGetter = (id) => this.getModuleInfo(id);
			shellModules = staticModuleGraph([APP_ENTRY], getModuleInfo);
			for (const id of staticModuleGraph(INDEPENDENT_ENTRIES, getModuleInfo))
				shellModules.delete(id);
			for (const id of shellModules) {
				if (getModuleInfo(id)?.isEntry) shellModules.delete(id);
			}
		},
		outputOptions(options) {
			// Small shared chunks otherwise form a request waterfall on HTTP/1.1 servers.
			return {
				...options,
				manualChunks: (id) => (shellModules.has(id) ? "admin-shell" : undefined),
			};
		},
	};
}

function linguiMacroPlugin(): Plugin {
	return {
		name: "lingui-macro",
		transform: {
			filter: { id: JS_TS_RE },
			async handler(code: string, id: string) {
				if (!code.includes("@lingui")) return;
				const result = await transformAsync(code, {
					filename: id,
					plugins: ["@lingui/babel-plugin-lingui-macro"],
					parserOpts: { plugins: ["jsx", "typescript"] },
				});
				if (!result?.code) return;
				return { code: result.code, map: result.map ?? undefined };
			},
		},
	};
}

/**
 * Emits `locales-manifest.json`, mapping each locale code to the chunk that
 * holds its compiled catalog. EmDash core reads it to apply `admin.locales`.
 */
function localeManifestPlugin(): Plugin {
	return {
		name: "emdash-locale-manifest",
		generateBundle(_options, bundle) {
			const entries: [string, string][] = [];
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk" || !output.facadeModuleId) continue;
				const code = LOCALE_CATALOG_RE.exec(output.facadeModuleId)?.[1];
				if (code) entries.push([code, output.fileName]);
			}
			if (entries.length === 0) {
				this.error("No locale catalog chunks were emitted. Run `pnpm locale:compile` first.");
			}
			const locales = Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
			this.emitFile({
				type: "asset",
				fileName: "locales-manifest.json",
				source: `${JSON.stringify({ locales }, null, "\t")}\n`,
			});
		},
	};
}

export default defineConfig({
	// locales/config and locales/emails are separate server-safe entries:
	// EmDash core imports them from API routes, where the locales barrel's
	// React/Kumo graph must not be pulled into the server bundle.
	entry: [
		"src/index.ts",
		"src/app-entry.ts",
		"src/locales/index.ts",
		"src/locales/server.ts",
		"src/locales/config.ts",
		"src/locales/emails.ts",
		"src/portable-text-table.ts",
		"src/html-block.ts",
		"src/slugify.ts",
	],
	format: ["esm"],

	dts: true,
	clean: true,
	platform: "browser",
	plugins: [linguiMacroPlugin(), localeManifestPlugin(), adminShellPlugin()],
	// @tiptap/suggestion is intentionally bundled (devDependency)
	inlineOnly: false,
	external: [
		"react",
		"react-dom",
		"react/jsx-runtime",
		"react/jsx-dev-runtime",
		// Keep TanStack external - Vite in consumer project will need to resolve these
		"@tanstack/react-router",
		"@tanstack/react-query",
	],
});
