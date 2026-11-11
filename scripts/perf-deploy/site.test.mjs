import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { resourceNames } from "./lib.mjs";
import { patchAstroConfig, patchWranglerConfig, stripJsonc } from "./site.mjs";

const includes = (text) => new RegExp(RegExp.escape(text));

const TEMPLATE_DIR = resolve(import.meta.dirname, "../../templates/blog-cloudflare");
const names = resourceNames("abcd1234");

void test("strips JSONC comments and trailing commas without touching strings", () => {
	const source = `{
		// line comment
		"url": "https://example.com/a//b", /* block */
		"text": "keep, } and /* this */",
		"list": [1, 2,],
	}`;
	assert.deepEqual(JSON.parse(stripJsonc(source)), {
		url: "https://example.com/a//b",
		text: "keep, } and /* this */",
		list: [1, 2],
	});
});

void test("points the shipped Wrangler config at the run's resources only", () => {
	const source = readFileSync(join(TEMPLATE_DIR, "wrangler.jsonc"), "utf8");
	const config = JSON.parse(patchWranglerConfig(source, { names, d1Id: "db-uuid", kvId: "kv-id" }));
	assert.equal(config.name, "emdash-perf-abcd1234");
	assert.deepEqual(config.d1_databases, [
		{ binding: "DB", database_name: "emdash-perf-abcd1234", database_id: "db-uuid" },
	]);
	assert.deepEqual(config.r2_buckets, [{ binding: "MEDIA", bucket_name: "emdash-perf-abcd1234" }]);
	assert.deepEqual(config.kv_namespaces, [{ binding: "SESSION", id: "kv-id" }]);
	assert.equal(config.workers_dev, false);
	assert.equal(config.routes, undefined);
	assert.doesNotMatch(JSON.stringify(config), includes("my-emdash"));
});

void test("selects the image service in the shipped Astro config", () => {
	const source = readFileSync(join(TEMPLATE_DIR, "astro.config.mjs"), "utf8");
	assert.match(
		patchAstroConfig(source, "cloudflare"),
		includes('adapter: cloudflare({ imageService: "cloudflare" }),'),
	);
	assert.equal(patchAstroConfig(source, "binding"), source);
	assert.throws(
		() => patchAstroConfig("adapter: cloudflare({ x: 1 }),", "cloudflare"),
		includes("found 0"),
	);
});
