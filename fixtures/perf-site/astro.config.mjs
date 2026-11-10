import { createRequire } from "node:module";

import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";

import { auditBuildGraph } from "../../scripts/perf-audit/build-graph.mjs";
const require = createRequire(import.meta.url);
const profiling = process.env.EMDASH_REACT_PROFILE === "1";

const target = process.env.EMDASH_FIXTURE_TARGET ?? "sqlite";

const localStorage = local({
	directory: "./uploads",
	baseUrl: "/_emdash/api/media/file",
});

// The perf audit measures the fonts real installs ship, including their swap shifts.
const fonts = process.env.EMDASH_FIXTURE_FONTS === "1" ? undefined : false;

// Off by default so query-count snapshots and default audits stay plugin-free.
const plugins = process.env.EMDASH_FIXTURE_PLUGINS === "1" ? [formsPlugin()] : [];

const sqliteIntegration = emdash({
	database: sqlite({ url: "file:./data.db" }),
	storage: localStorage,
	fonts,
	plugins,
});

// No connection settings: `pg` reads PG* from the environment at runtime, so one
// build can target a per-run database through the audit's latency proxy.
const postgresIntegration = emdash({
	database: postgres({}),
	storage: localStorage,
	fonts,
	plugins,
});

const d1Integration = emdash({
	database: d1({ binding: "DB", session: "auto" }),
	storage: r2({ binding: "MEDIA" }),
	fonts: false,
});

export default defineConfig({
	output: "server",
	vite: {
		plugins: [auditBuildGraph()],
		build: { minify: !profiling },
		resolve: {
			alias: profiling
				? [{ find: /^react-dom\/client$/, replacement: require.resolve("react-dom/profiling") }]
				: [],
		},
	},
	adapter:
		target === "d1"
			? cloudflare()
			: node({
					mode: "standalone",
				}),
	integrations: [
		react(),
		target === "d1"
			? d1Integration
			: target === "postgres"
				? postgresIntegration
				: sqliteIntegration,
	],
	devToolbar: { enabled: false },
});
