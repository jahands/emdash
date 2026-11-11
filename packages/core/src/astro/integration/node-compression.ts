/**
 * Build wiring for compression on the `@astrojs/node` standalone server.
 *
 * The adapter's server entry is swapped for a virtual module that re-exports
 * it with a compressing request listener (see `astro/node/compression.ts`).
 * After the build, client assets are precompressed and listed in a manifest
 * next to the server entry.
 */

import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { AstroConfig, AstroIntegrationLogger } from "astro";
import type { Plugin } from "vite";

import { precompressAssets } from "../node/precompress.js";

const NODE_SERVER_ENTRY = "@astrojs/node/server.js";
const VIRTUAL_ENTRY_ID = "virtual:emdash/node-server";
const RESOLVED_ENTRY_ID = "\0" + VIRTUAL_ENTRY_ID;
const VIRTUAL_AUTOSTART_ID = "virtual:emdash/node-autostart";
const RESOLVED_AUTOSTART_ID = "\0" + VIRTUAL_AUTOSTART_ID;

export const PRECOMPRESSED_MANIFEST = "emdash-precompressed.json";

/**
 * Evaluated before the adapter's entry, which starts the server as soon as it
 * loads unless `ASTRO_NODE_AUTOSTART` is `disabled`. The wrapper restores the
 * variable and starts the compressing server itself.
 */
const AUTOSTART_MODULE = `export const autostart = process.env.ASTRO_NODE_AUTOSTART;
process.env.ASTRO_NODE_AUTOSTART = "disabled";
`;

function entryModule(config: AstroConfig): string {
	let clientDir = relative(fileURLToPath(config.build.server), fileURLToPath(config.build.client))
		.split("\\")
		.join("/");
	if (!clientDir.endsWith("/")) clientDir += "/";
	return `import { autostart } from ${JSON.stringify(VIRTUAL_AUTOSTART_ID)};
import * as adapter from ${JSON.stringify(NODE_SERVER_ENTRY)};
import { wrapNodeStandalone } from "emdash/internal/node-compression";

export * from ${JSON.stringify(NODE_SERVER_ENTRY)};

const server = wrapNodeStandalone(adapter, {
	autostart,
	manifest: new URL(${JSON.stringify(PRECOMPRESSED_MANIFEST)}, import.meta.url),
	clientDir: new URL(${JSON.stringify(clientDir)}, import.meta.url),
	base: ${JSON.stringify(config.base)},
});

export const handler = server.handler;
export const startServer = server.startServer;
`;
}

export interface NodeCompression {
	vitePlugin: Plugin;
	setConfig(config: AstroConfig): void;
	/** Precompress client assets when the build used the compressing entry. */
	precompress(logger: AstroIntegrationLogger): Promise<void>;
}

export function createNodeCompression(): NodeCompression {
	let config: AstroConfig | undefined;
	let entryWrapped = false;

	const vitePlugin: Plugin = {
		name: "emdash:node-compression",
		apply: "build",
		// Without `pre`, the adapter entry is resolved before this hook sees it.
		enforce: "pre",
		resolveId(id, _importer, options) {
			if (id === NODE_SERVER_ENTRY && options.isEntry && this.environment.name === "ssr") {
				return RESOLVED_ENTRY_ID;
			}
			if (id === VIRTUAL_AUTOSTART_ID) return RESOLVED_AUTOSTART_ID;
		},
		load(id) {
			if (id === RESOLVED_ENTRY_ID && config) {
				entryWrapped = true;
				return entryModule(config);
			}
			if (id === RESOLVED_AUTOSTART_ID) return AUTOSTART_MODULE;
		},
	};

	return {
		vitePlugin,
		setConfig(value) {
			config = value;
		},
		async precompress(logger) {
			if (!entryWrapped || !config) return;
			const clientDir = fileURLToPath(config.build.client);
			const manifest = await precompressAssets(clientDir, config.build.assets);
			await writeFile(
				new URL(PRECOMPRESSED_MANIFEST, config.build.server),
				JSON.stringify(manifest),
			);
			logger.info(`Precompressed ${Object.keys(manifest.files).length} client assets`);
		},
	};
}
