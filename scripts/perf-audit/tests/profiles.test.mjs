import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseJsonc, transformAstroConfig, transformWranglerConfig } from "../lib/materialize.mjs";
import {
	allProfileIds,
	defaultProfileIds,
	resolveProfile as resolveBare,
	selectProfiles,
	withPorts,
} from "../lib/profiles.mjs";

const templates = join(import.meta.dirname, "../../../templates");
const read = (template, file) => readFileSync(join(templates, template, file), "utf8");
const pgUrl = "postgres://postgres:pw@127.0.0.1:14601/perf";
const UNKNOWN_PROFILE = /Unknown profile/;
const EXPECTED_ONE = /expected exactly one "emdash\(\{"/;
const resolveProfile = (id) => withPorts(resolveBare(id), { port: 15123, proxyPort: 15124 });
const has = (text, part) => assert.ok(text.includes(part), `missing ${part}`);

void test("the default set is the blog on every platform plus URL-mode images", () => {
	assert.deepEqual(defaultProfileIds(), [
		"blog-node-sqlite",
		"blog-node-postgres",
		"blog-workerd-d1",
		"blog-workerd-d1-url-images",
		"blog-workerd-postgres",
	]);
	assert.equal(selectProfiles({ profiles: [], profileSet: "all" }).length, allProfileIds().length);
	assert.throws(() => resolveProfile("blog-node-mysql"), UNKNOWN_PROFILE);
});

void test("a profile is served from the ports a run leased for it", () => {
	const bare = resolveBare("portfolio-workerd-d1");
	assert.equal(bare.sourceTemplate, "portfolio-cloudflare");
	assert.equal(bare.origin, undefined);
	const p = withPorts(bare, { port: 15010 });
	assert.equal(p.origin, "http://localhost:15010");
	assert.equal(p.proxyPort, null);
});

for (const template of ["blog", "portfolio", "marketing", "starter"]) {
	void test(`${template}: node profiles change only siteUrl and the database`, () => {
		const source = read(template, "astro.config.mjs");
		const sqlite = transformAstroConfig(source, resolveProfile(`${template}-node-sqlite`));
		const siteUrl = `\n\t\t\tsiteUrl: "http://localhost:${resolveProfile(`${template}-node-sqlite`).port}",`;
		assert.ok(sqlite.includes(siteUrl));
		assert.equal(sqlite.replace(siteUrl, ""), source);

		const pg = transformAstroConfig(source, resolveProfile(`${template}-node-postgres`), {
			postgresUrl: pgUrl,
		});
		has(pg, 'import { postgres } from "emdash/db";');
		has(pg, `database: postgres({ connectionString: "${pgUrl}" })`);
		assert.ok(!pg.includes("sqlite("));
		has(pg, "storage: local(");
	});

	void test(`${template}: workerd profiles switch the database and image service only`, () => {
		const source = read(`${template}-cloudflare`, "astro.config.mjs");
		const d1 = transformAstroConfig(source, resolveProfile(`${template}-workerd-d1`));
		has(d1, "adapter: cloudflare(),");
		has(d1, "database: d1(");

		const url = transformAstroConfig(source, resolveProfile(`${template}-workerd-d1-url-images`));
		has(url, 'adapter: cloudflare({ imageService: "cloudflare" }),');

		const hd = transformAstroConfig(source, resolveProfile(`${template}-workerd-postgres`));
		has(hd, 'import { hyperdrive, r2 } from "@emdash-cms/cloudflare";');
		has(hd, 'database: hyperdrive({ binding: "HYPERDRIVE" })');
		has(hd, 'storage: r2({ binding: "MEDIA" })');
	});

	void test(`${template}: wrangler config gains a local D1 id or a Hyperdrive binding`, () => {
		const config = parseJsonc(read(`${template}-cloudflare`, "wrangler.jsonc"));
		const d1 = transformWranglerConfig(config, resolveProfile(`${template}-workerd-d1`));
		assert.equal(d1.d1_databases[0].database_id, "perf-audit-local");
		assert.deepEqual(d1.r2_buckets, config.r2_buckets);

		const hd = transformWranglerConfig(config, resolveProfile(`${template}-workerd-postgres`), {
			postgresUrl: pgUrl,
		});
		assert.equal(hd.d1_databases, undefined);
		assert.deepEqual(hd.hyperdrive, [
			{ binding: "HYPERDRIVE", id: "perf-audit-local", localConnectionString: pgUrl },
		]);
	});
}

void test("a template that changed shape fails loudly", () => {
	assert.throws(
		() => transformAstroConfig("export default {}", resolveProfile("blog-node-sqlite")),
		EXPECTED_ONE,
	);
});

void test("parseJsonc keeps strings that look like comments", () => {
	assert.deepEqual(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1, 2,], // tail\n }'), {
		a: "http://x//y",
		b: [1, 2],
	});
});
