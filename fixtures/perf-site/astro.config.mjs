import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";

const target = process.env.EMDASH_FIXTURE_TARGET ?? "sqlite";

const localStorage = local({
	directory: "./uploads",
	baseUrl: "/_emdash/api/media/file",
});

// The perf audit measures the fonts real installs ship, including their swap shifts.
const fonts = process.env.EMDASH_FIXTURE_FONTS === "1" ? undefined : false;

const sqliteIntegration = emdash({
	database: sqlite({ url: "file:./data.db" }),
	storage: localStorage,
	fonts,
});

// No connection settings: `pg` reads PG* from the environment at runtime, so one
// build can target a per-run database through the audit's latency proxy.
const postgresIntegration = emdash({
	database: postgres({}),
	storage: localStorage,
	fonts,
});

const d1Integration = emdash({
	database: d1({ binding: "DB", session: "auto" }),
	storage: r2({ binding: "MEDIA" }),
	fonts: false,
});

export default defineConfig({
	output: "server",
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
