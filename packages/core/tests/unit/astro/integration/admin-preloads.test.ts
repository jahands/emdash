import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type ClientBundle,
	type ClientChunk,
	clientFileHref,
	collectAdminPreloads,
	createAdminPreloadsPlugin,
	adminBootModules,
} from "../../../../src/astro/integration/admin-preloads.js";

const ADMIN_DIST = "/site/node_modules/@emdash-cms/admin/dist";
const ISLAND = "/site/node_modules/emdash/dist/astro/routes/PluginRegistry.mjs";
const PLUGIN_ADMIN_ENTRY = "\0virtual:emdash/admin-entry";

function chunk(
	fileName: string,
	imports: string[] = [],
	facadeModuleId: string | null = null,
): ClientChunk {
	return { type: "chunk", fileName, imports, facadeModuleId };
}

function bundleOf(...chunks: ClientChunk[]): ClientBundle {
	return Object.fromEntries(chunks.map((entry) => [entry.fileName, entry]));
}

const href = (fileName: string) => `/${fileName}`;

describe("collectAdminPreloads", () => {
	it("records the island's static closure and what each route module adds to it", () => {
		const bundle = bundleOf(
			chunk("_astro/PluginRegistry.js", ["_astro/admin.js"], ISLAND),
			chunk("_astro/admin.js", ["_astro/react.js"]),
			chunk("_astro/react.js"),
			chunk(
				"_astro/ContentEditor.js",
				["_astro/admin.js", "_astro/tiptap.js"],
				`${ADMIN_DIST}/components/ContentEditor.js`,
			),
			chunk("_astro/tiptap.js", ["_astro/react.js"]),
			chunk("_astro/Settings.js", ["_astro/admin.js"], `${ADMIN_DIST}/components/Settings.js`),
			chunk("_astro/public-island.js", ["_astro/react.js"], "/site/src/components/Search.tsx"),
		);

		const preloads = collectAdminPreloads(bundle, {
			adminDistPath: ADMIN_DIST,
			pluginAdminEntryId: PLUGIN_ADMIN_ENTRY,
			href,
		});

		expect(preloads?.boot.toSorted()).toEqual([
			"/_astro/PluginRegistry.js",
			"/_astro/admin.js",
			"/_astro/react.js",
		]);
		expect(preloads?.routes).toEqual({
			"components/ContentEditor": ["/_astro/ContentEditor.js", "/_astro/tiptap.js"],
			"components/Settings": ["/_astro/Settings.js"],
		});
	});

	it("counts the plugin admin entry as boot, since the admin waits for it", () => {
		const bundle = bundleOf(
			chunk("_astro/PluginRegistry.js", [], ISLAND),
			chunk("_astro/emdash-admin.js", ["_astro/plugin.js"], PLUGIN_ADMIN_ENTRY),
			chunk("_astro/plugin.js"),
		);

		const preloads = collectAdminPreloads(bundle, {
			adminDistPath: ADMIN_DIST,
			pluginAdminEntryId: PLUGIN_ADMIN_ENTRY,
			href,
		});

		expect(preloads?.boot.toSorted()).toEqual([
			"/_astro/PluginRegistry.js",
			"/_astro/emdash-admin.js",
			"/_astro/plugin.js",
		]);
	});

	it("records nothing for a client build without the admin", () => {
		const bundle = bundleOf(
			chunk("_astro/public-island.js", [], "/site/src/components/Search.tsx"),
		);
		expect(
			collectAdminPreloads(bundle, {
				adminDistPath: ADMIN_DIST,
				pluginAdminEntryId: PLUGIN_ADMIN_ENTRY,
				href,
			}),
		).toBeUndefined();
	});
});

describe("adminBootModules", () => {
	function graph(
		modules: Record<string, { entry?: boolean; imports?: string[]; dynamic?: string[] }>,
	) {
		return {
			getModuleIds: () => Object.keys(modules)[Symbol.iterator](),
			getModuleInfo: (id: string) => {
				const info = modules[id];
				if (!info) return null;
				return {
					isEntry: info.entry ?? false,
					importedIds: info.imports ?? [],
					dynamicallyImportedIds: info.dynamic ?? [],
				};
			},
		};
	}

	it("leaves out modules that only routes or also the public site use", () => {
		const boot = adminBootModules(
			graph({
				[ISLAND]: { entry: true, imports: ["admin", "react"], dynamic: ["editor"] },
				admin: { imports: ["react"] },
				react: {},
				editor: { imports: ["admin", "tiptap", "react"] },
				tiptap: {},
				"/site/src/components/Search.tsx": { entry: true, imports: ["react"] },
			}),
			PLUGIN_ADMIN_ENTRY,
		);

		expect([...(boot ?? [])].toSorted()).toEqual([ISLAND, "admin"].toSorted());
	});
});

describe("clientFileHref", () => {
	it("prefixes the site base", () => {
		expect(clientFileHref({ base: "/", build: {} as never })("_astro/a.js")).toBe("/_astro/a.js");
		expect(clientFileHref({ base: "/docs", build: {} as never })("_astro/a.js")).toBe(
			"/docs/_astro/a.js",
		);
	});

	it("uses the assets prefix when one is set", () => {
		expect(
			clientFileHref({ base: "/", build: { assetsPrefix: "https://cdn.example.com/" } as never })(
				"_astro/a.js",
			),
		).toBe("https://cdn.example.com/_astro/a.js");
		expect(
			clientFileHref({
				base: "/",
				build: {
					assetsPrefix: { js: "https://js.example.com", fallback: "https://cdn.example.com" },
				} as never,
			})("_astro/a.js"),
		).toBe("https://js.example.com/_astro/a.js");
	});
});

describe("createAdminPreloadsPlugin", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "emdash-admin-preloads-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function plugin() {
		return createAdminPreloadsPlugin({
			adminDistPath: ADMIN_DIST,
			pluginAdminEntryId: PLUGIN_ADMIN_ENTRY,
			astroConfig: { base: "/", build: {} as never },
		});
	}

	type Hooks = Record<string, (this: unknown, ...args: unknown[]) => unknown>;

	it("writes the client build's preloads into the server chunk built before it", async () => {
		const instance = plugin() as unknown as Hooks;
		instance.configResolved!.call({}, { command: "build" });
		const moduleCode = instance.load!.call({}, "\0virtual:emdash/admin-preloads") as string;
		const serverCode = `${moduleCode}\nexport const used = adminPreloadsJson;\n`;
		writeFileSync(join(dir, "admin.mjs"), serverCode);

		const server = { environment: { config: { consumer: "server" } } };
		instance.generateBundle!.call(
			server,
			{ dir },
			{ "admin.mjs": { type: "chunk", fileName: "admin.mjs", code: serverCode } },
		);

		const client = { environment: { config: { consumer: "client" } } };
		instance.generateBundle!.call(
			client,
			{ dir: join(dir, "client") },
			bundleOf(chunk("_astro/PluginRegistry.js", [], ISLAND)),
		);
		instance.writeBundle!.call(client);

		const written = readFileSync(join(dir, "admin.mjs"), "utf8");
		const module = await import(`data:text/javascript,${encodeURIComponent(written)}`);
		expect(JSON.parse(module.adminPreloadsJson)).toEqual({
			boot: ["/_astro/PluginRegistry.js"],
			routes: {},
		});
	});

	it("serves an empty value in dev", () => {
		const instance = plugin() as unknown as Hooks;
		instance.configResolved!.call({}, { command: "serve" });
		expect(instance.load!.call({}, "\0virtual:emdash/admin-preloads")).toBe(
			'export const adminPreloadsJson = "";',
		);
	});

	it("leaves a site's own chunking alone", () => {
		const instance = plugin() as unknown as Hooks;
		const env = { command: "build" };
		expect(instance.configEnvironment!.call({}, "client", {}, env)).toMatchObject({
			build: { rolldownOptions: { output: { codeSplitting: { groups: expect.any(Array) } } } },
		});
		expect(
			instance.configEnvironment!.call(
				{},
				"client",
				{ build: { rolldownOptions: { output: { manualChunks: () => undefined } } } },
				env,
			),
		).toBeUndefined();
		expect(
			instance.configEnvironment!.call({}, "ssr", { consumer: "server" }, env),
		).toBeUndefined();
	});
});
