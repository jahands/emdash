/**
 * Build-time support for preloading the admin's JavaScript from the admin
 * page. The client build is analysed for the admin island's static import
 * closure and for each admin route module's closure, and the result is
 * written into the already-built server, which renders `modulepreload` links
 * for the boot closure and the requested route.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AstroConfig } from "astro";
import type { Plugin } from "vite";

import type { AdminPreloads } from "../../utils/admin-preloads.js";

export const VIRTUAL_ADMIN_PRELOADS_ID = "virtual:emdash/admin-preloads";
const RESOLVED_ADMIN_PRELOADS_ID = "\0" + VIRTUAL_ADMIN_PRELOADS_ID;
const PLACEHOLDER = "__EMDASH_ADMIN_PRELOADS__";
const PLACEHOLDER_LITERAL = /(["'`])__EMDASH_ADMIN_PRELOADS__\1/g;
const ADMIN_ISLAND_RE = /[/\\]astro[/\\]routes[/\\]PluginRegistry\.(?:mjs|js|tsx)$/;
const JS_FILE = /\.js$/;
const TRAILING_SLASH = /\/$/;
const REPEATED_SLASHES = /\/{2,}/g;

/** A chunk of a client build, as far as preload analysis needs one. */
export interface ClientChunk {
	type: "chunk";
	fileName: string;
	facadeModuleId: string | null;
	imports: readonly string[];
}

/** The parts of a client build output that preload analysis reads. */
export type ClientBundle = Record<string, ClientChunk | { type: "asset" }>;

function toVitePath(path: string): string {
	return path.replaceAll("\\", "/");
}

function staticClosure(bundle: ClientBundle, fileName: string): string[] {
	const files = new Set<string>();
	const pending = [fileName];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || files.has(file)) continue;
		const chunk = bundle[file];
		if (chunk?.type !== "chunk") continue;
		files.add(file);
		pending.push(...chunk.imports);
	}
	return [...files];
}

/**
 * The admin's preloads in a client build: the static closure of the admin
 * island plus the plugin admin entry (both load before the admin renders),
 * and for each admin route module the files its closure adds to that.
 */
export function collectAdminPreloads(
	bundle: ClientBundle,
	options: {
		adminDistPath: string;
		pluginAdminEntryId: string;
		href: (fileName: string) => string;
	},
): AdminPreloads | undefined {
	const chunks = Object.values(bundle).filter((chunk) => chunk.type === "chunk");
	const island = chunks.find(
		(chunk) => chunk.facadeModuleId && ADMIN_ISLAND_RE.test(chunk.facadeModuleId),
	);
	if (!island) return undefined;

	const boot = new Set(staticClosure(bundle, island.fileName));
	const pluginAdmins = chunks.find((chunk) => chunk.facadeModuleId === options.pluginAdminEntryId);
	if (pluginAdmins) {
		for (const file of staticClosure(bundle, pluginAdmins.fileName)) boot.add(file);
	}

	const distPrefix = `${toVitePath(options.adminDistPath).replace(TRAILING_SLASH, "")}/`;
	const routes: Record<string, string[]> = {};
	for (const chunk of chunks) {
		const id = chunk.facadeModuleId && toVitePath(chunk.facadeModuleId);
		if (!id?.startsWith(distPrefix) || !JS_FILE.test(id)) continue;
		const module = id.slice(distPrefix.length).replace(JS_FILE, "");
		routes[module] = staticClosure(bundle, chunk.fileName)
			.filter((file) => !boot.has(file))
			.map(options.href);
	}

	return { boot: Array.from(boot, options.href), routes };
}

/** The URL a client build file is served from, as Astro links it. */
export function clientFileHref(
	astroConfig: Pick<AstroConfig, "base" | "build">,
): (fileName: string) => string {
	const { assetsPrefix } = astroConfig.build;
	const prefix =
		typeof assetsPrefix === "string" ? assetsPrefix : (assetsPrefix?.js ?? assetsPrefix?.fallback);
	if (prefix) return (fileName) => `${prefix.replace(TRAILING_SLASH, "")}/${fileName}`;
	const base = `/${astroConfig.base}/`.replace(REPEATED_SLASHES, "/");
	return (fileName) => `${base}${fileName}`;
}

interface ModuleGraph {
	getModuleIds(): IterableIterator<string>;
	getModuleInfo(id: string): {
		isEntry: boolean;
		importedIds: readonly string[];
		dynamicallyImportedIds: readonly string[];
	} | null;
}

function reachable(
	graph: ModuleGraph,
	roots: readonly string[],
	options: { dynamic: boolean; stop?: ReadonlySet<string> },
): Set<string> {
	const seen = new Set<string>();
	const pending = [...roots];
	while (pending.length > 0) {
		const id = pending.pop();
		if (id === undefined || seen.has(id) || options.stop?.has(id)) continue;
		const info = graph.getModuleInfo(id);
		if (!info) continue;
		seen.add(id);
		pending.push(...info.importedIds);
		if (options.dynamic) pending.push(...info.dynamicallyImportedIds);
	}
	return seen;
}

/**
 * The modules statically reachable from the admin island, minus any the public
 * site's entries also reach. The plugin admin entry is not a root: it is an
 * emitted chunk loaded by file URL, and moving its module into a group leaves
 * that URL with an unresolved hash. It is not a public entry either.
 */
export function adminBootModules(
	graph: ModuleGraph,
	pluginAdminEntryId: string,
): Set<string> | undefined {
	const ids = [...graph.getModuleIds()];
	const island = ids.find((id) => ADMIN_ISLAND_RE.test(id));
	if (!island) return undefined;
	const admin = new Set([island, pluginAdminEntryId]);
	const publicEntries = ids.filter((id) => !admin.has(id) && graph.getModuleInfo(id)?.isEntry);
	const shared = reachable(graph, publicEntries, { dynamic: true, stop: admin });
	const boot = reachable(graph, [island], { dynamic: false, stop: new Set([pluginAdminEntryId]) });
	for (const id of shared) boot.delete(id);
	return boot;
}

/**
 * Serves `virtual:emdash/admin-preloads` and fills it in once the client is
 * built. Astro builds the server before the client, so the server chunk is
 * written with a placeholder that the client build replaces on disk.
 *
 * Also puts the admin's boot modules in one chunk. Left to itself the bundler
 * splits them into a file per sharing pattern with the lazily loaded routes,
 * over a hundred small requests on the admin's first load. The `$initial` tag
 * keeps modules that only routes use out of the chunk: the module graph walk
 * also passes through re-exports that tree-shaking drops. Modules the public
 * site also uses keep the default chunking, and a site that configures its own
 * chunking keeps it.
 */
export function createAdminPreloadsPlugin(options: {
	adminDistPath: string;
	pluginAdminEntryId: string;
	astroConfig: Pick<AstroConfig, "base" | "build">;
}): Plugin {
	let command: "build" | "serve" = "serve";
	const serverFiles = new Set<string>();
	let preloads: AdminPreloads | undefined;
	let bootModules: Set<string> | undefined;

	return {
		name: "emdash-admin-preloads",
		configEnvironment(name, config, env) {
			if (env.command !== "build" || config.consumer === "server" || name !== "client") return;
			const outputs = [config.build?.rolldownOptions?.output ?? {}].flat();
			const customized = outputs.some(
				(output) =>
					output.codeSplitting !== undefined ||
					output.advancedChunks !== undefined ||
					output.manualChunks !== undefined,
			);
			const signatures = config.build?.rolldownOptions?.preserveEntrySignatures;
			if (
				customized ||
				outputs.length > 1 ||
				(signatures !== undefined && signatures !== "exports-only")
			) {
				return;
			}
			return {
				build: {
					rolldownOptions: {
						preserveEntrySignatures: "allow-extension",
						output: {
							codeSplitting: {
								groups: [
									{
										name: "admin",
										test: (id: string) => bootModules?.has(id) ?? false,
										priority: 2,
										tags: ["$initial"],
										includeDependenciesRecursively: false,
									},
								],
							},
						},
					},
				},
			};
		},
		configResolved(config) {
			command = config.command;
		},
		buildEnd() {
			if (command !== "build" || this.environment.config.consumer !== "client") return;
			bootModules = adminBootModules(this, options.pluginAdminEntryId);
		},
		resolveId(id) {
			if (id === VIRTUAL_ADMIN_PRELOADS_ID) return RESOLVED_ADMIN_PRELOADS_ID;
		},
		load(id) {
			if (id !== RESOLVED_ADMIN_PRELOADS_ID) return;
			const value = command === "build" ? PLACEHOLDER : "";
			return `export const adminPreloadsJson = ${JSON.stringify(value)};`;
		},
		generateBundle(outputOptions, bundle) {
			if (command !== "build") return;
			if (this.environment.config.consumer === "client") {
				preloads = collectAdminPreloads(bundle, {
					adminDistPath: options.adminDistPath,
					pluginAdminEntryId: options.pluginAdminEntryId,
					href: clientFileHref(options.astroConfig),
				});
				return;
			}
			const dir = outputOptions.dir;
			if (!dir) return;
			for (const output of Object.values(bundle)) {
				if (output.type === "chunk" && output.code.includes(PLACEHOLDER)) {
					serverFiles.add(resolve(dir, output.fileName));
				}
			}
		},
		writeBundle() {
			if (this.environment.config.consumer !== "client" || !preloads) return;
			const literal = JSON.stringify(JSON.stringify(preloads));
			for (const file of serverFiles) {
				const code = readFileSync(file, "utf8");
				writeFileSync(
					file,
					code.replace(PLACEHOLDER_LITERAL, () => literal),
				);
			}
		},
	};
}
