import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../lib/args.mjs";
import { generateSignInToken } from "../lib/auth.mjs";
import { bytesByPackage } from "../lib/build-output.mjs";
import { documentModuleScripts, staticSpecifiers } from "../lib/closure.mjs";
import { createBackendParser, extractSql, startLatencyProxy } from "../lib/latency-proxy.mjs";
import { planOwnerEdits } from "../lib/seed.mjs";
import { buildTargets, filterTargets } from "../lib/targets.mjs";

const templates = join(import.meta.dirname, "../../../templates");
const seedOf = (t) => JSON.parse(readFileSync(join(templates, t, "seed/seed.json"), "utf8"));

const message = (type, body = Buffer.alloc(0)) => {
	const header = Buffer.alloc(5);
	header.write(type, 0, "latin1");
	header.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([header, body]);
};

void test("backend parser reassembles messages split across chunks and skips the SSL reply", () => {
	const types = [];
	const parser = createBackendParser((type) => types.push(type));
	parser.expectUnframedByte();
	const stream = Buffer.concat([
		Buffer.from("N"),
		message("R", Buffer.alloc(4)),
		message("Z", Buffer.from("I")),
	]);
	for (const byte of stream) parser.push(Buffer.from([byte]));
	assert.deepEqual(types, ["R", "Z"]);
});

void test("extractSql reads Query and Parse messages", () => {
	assert.equal(extractSql(message("Q", Buffer.from("select 1\0"))), "select 1");
	const parse = Buffer.concat([Buffer.from("stmt\0"), Buffer.from("select $1\0"), Buffer.alloc(2)]);
	assert.equal(extractSql(Buffer.concat([message("P", parse), message("S")])), "select $1");
});

void test("the latency proxy delays round trips and records them", async () => {
	const upstream = createServer((socket) => {
		socket.on("data", () => socket.write(message("Z", Buffer.from("I"))));
	});
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	const proxy = startLatencyProxy({
		listenPort: 0,
		targetHost: "127.0.0.1",
		targetPort: upstream.address().port,
		latencyMs: 40,
	});
	await proxy.listening;
	const port = proxy.address().port;
	const client = createConnection({ host: "127.0.0.1", port });
	const roundTrip = (payload) =>
		new Promise((resolve) => {
			const started = performance.now();
			client.once("data", () => resolve(performance.now() - started));
			client.write(payload);
		});
	const since = performance.now();
	const startup = Buffer.alloc(8);
	startup.writeInt32BE(8, 0);
	startup.writeInt32BE(196608, 4);
	await roundTrip(startup);
	const elapsed = await roundTrip(message("Q", Buffer.from("select 1\0")));
	assert.ok(elapsed >= 38, `round trip took ${elapsed} ms`);
	const window = proxy.window(since);
	assert.equal(window.connections.length, 1);
	assert.equal(window.queries.length, 1);
	assert.equal(window.queries[0].sql, "select 1");
	client.destroy();
	await proxy.close();
	upstream.close();
});

void test("the latency proxy keeps bytes in order under load", async () => {
	const received = [];
	const upstream = createServer((socket) => socket.on("data", (chunk) => received.push(chunk)));
	await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
	const proxy = startLatencyProxy({
		listenPort: 0,
		targetHost: "127.0.0.1",
		targetPort: upstream.address().port,
		latencyMs: 6,
	});
	await proxy.listening;
	const client = createConnection({ host: "127.0.0.1", port: proxy.address().port });
	await new Promise((r) => client.once("connect", r));
	const sent = [];
	for (let i = 0; i < 400; i++) {
		const chunk = Buffer.from(`${i},`);
		sent.push(chunk);
		client.write(chunk);
		if (i % 7 === 0) await new Promise((r) => setTimeout(r, Math.random() * 2));
	}
	const expected = Buffer.concat(sent).toString();
	const deadline = Date.now() + 5000;
	while (Buffer.concat(received).length < expected.length && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal(Buffer.concat(received).toString(), expected);
	client.destroy();
	await proxy.close();
	upstream.close();
});

void test("sign-in tokens hash the raw bytes like @emdash-cms/auth", async () => {
	const { hashToken } = await import(
		join(import.meta.dirname, "../../../packages/auth/dist/index.mjs")
	);
	const { token, hash } = generateSignInToken();
	assert.equal(hashToken(token), hash);
});

void test("owner edits target the collection with images and rich text", () => {
	assert.deepEqual(planOwnerEdits(seedOf("blog")), {
		collection: "posts",
		imageField: "featured_image",
		bodyField: "content",
		titleField: "title",
		excerptField: "excerpt",
		taxonomy: "category",
		terms: ["development", "design", "notes"],
		seeded: 8,
	});
	assert.equal(planOwnerEdits(seedOf("portfolio")).collection, "projects");
	assert.equal(planOwnerEdits(seedOf("marketing")), null);
});

void test("targets cover the admin and public screens", () => {
	const targets = buildTargets({
		template: "blog",
		collections: ["posts", "pages"],
		heaviest: { id: "01X", slug: "guide", collection: "posts" },
		taxonomy: "category",
		term: "development",
		menu: "primary",
	});
	const paths = new Set(targets.map((t) => t.path));
	for (const expected of [
		"/_emdash/admin/",
		"/_emdash/admin/content/posts",
		"/_emdash/admin/content/posts/01X",
		"/_emdash/admin/media",
		"/_emdash/admin/settings/general",
		"/_emdash/admin/menus/primary",
		"/_emdash/admin/taxonomies/category",
		"/_emdash/admin/users",
		"/_emdash/admin/login",
		"/_emdash/admin/content/posts/new",
		"/_emdash/admin/content-types/posts",
		"/_emdash/admin/comments",
		"/_emdash/admin/redirects",
		"/_emdash/admin/import/wordpress",
		"/",
		"/posts/guide",
		"/category/development",
	]) {
		assert.ok(paths.has(expected), expected);
	}
	assert.equal(targets.find((t) => t.path === "/_emdash/admin/login").signedOut, true);
	assert.ok(!paths.has("/_emdash/admin/plugins/marketplace"));
	assert.deepEqual(
		filterTargets(targets, ["media"]).map((t) => t.path),
		["/_emdash/admin/media", "/_emdash/admin/settings/media-usage"],
	);
});

void test("module scripts include Astro island components and renderers", () => {
	const html = `<link rel="modulepreload" href="/_astro/a.js"><script type="module" src="/_astro/b.js"></script>
		<astro-island uid="x" component-url="/_astro/App.js" renderer-url="/_astro/client.js" props="{&quot;a&quot;:1}"></astro-island>`;
	assert.deepEqual(documentModuleScripts(html, "http://x/_emdash/admin/"), [
		"http://x/_astro/b.js",
		"http://x/_astro/a.js",
		"http://x/_astro/App.js",
		"http://x/_astro/client.js",
	]);
	assert.deepEqual(
		staticSpecifiers(
			'import{a as b}from"./c.js";export*from"./d.js";import"./e.js";import("./lazy.js")',
		),
		["./c.js", "./d.js", "./e.js"],
	);
});

void test("arguments parse into options", () => {
	const o = parseArgs([
		"--profile",
		"blog-workerd-d1",
		"--profile=blog-node-sqlite",
		"--only",
		"media",
		"--viewport",
		"mobile",
		"--max-cls",
		"0.1",
		"--threshold-server-gz",
		"10",
		"--network",
		"slow4g",
		"--locale",
		"ar",
		"--dark",
	]);
	assert.deepEqual(o.profiles, ["blog-workerd-d1", "blog-node-sqlite"]);
	assert.deepEqual(o.viewports, ["mobile"]);
	assert.equal(o.budgets.cls, 0.1);
	assert.equal(o.thresholds.serverGzipPercent, 10);
	assert.equal(o.thresholds.cls, 0.01);
	assert.equal(o.network, "slow4g");
	assert.equal(o.locale, "ar");
	assert.equal(o.dark, true);
	assert.throws(() => parseArgs(["--viewport", "tablet"]), {
		message: "--viewport must be desktop, mobile or both",
	});
	assert.throws(() => parseArgs(["--max-cls"]), { message: "--max-cls needs a value" });
	assert.throws(
		() => parseArgs(["--bogus"]),
		(error) => error.message.startsWith("Unknown option --bogus"),
	);
});

void test("server bytes are attributed to packages by region marker", () => {
	const file = [
		"//#region ../../../node_modules/.pnpm/kysely@0.29.0/node_modules/kysely/dist/index.js",
		"x".repeat(100),
		"//#endregion",
		"//#region ../../../packages/admin/dist/messages-abc.js",
		"y".repeat(300),
		"//#endregion",
		"//#region ../../../packages/core/dist/index.mjs",
		"z".repeat(50),
		"//#endregion",
		"//#region src/pages/index.astro",
		"w".repeat(10),
		"//#endregion",
	].join("\n");
	assert.deepEqual(
		bytesByPackage([file]).map((p) => p.package),
		["packages/admin (locale catalogs)", "kysely", "packages/core", "(site)"],
	);
});
