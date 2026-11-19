import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_THRESHOLDS, distortingOptions, parseArgs } from "../lib/args.mjs";
import {
	attributeFile,
	classifySource,
	composeFiles,
	compositionDeltas,
	decodeMappings,
} from "../lib/bundle-composition.mjs";
import { bundleDeltas, compareResults, typingRegressed } from "../lib/evaluate.mjs";
import {
	bulkEntries,
	formatLike,
	insertStatements,
	LOCALE_SHARES,
	STATUS_SHARES,
} from "../lib/large-seed.mjs";
import { sourceMapConfig } from "../lib/materialize.mjs";
import { lateDiscoveries } from "../lib/metrics.mjs";
import { ADMIN_BOOT_REQUESTS, holdTriggers } from "../lib/page-run.mjs";
import { planFlags, planRequests, queryKind } from "../lib/query-plans.mjs";
import { passSelected, screenshotRoot } from "../lib/run-profile.mjs";
import { bestOfSamples, busyPercent } from "../lib/samples.mjs";
import { duplicateQueries } from "../lib/sql-text.mjs";
import { filterTargets, matchesOnly } from "../lib/targets.mjs";

const NEEDS_HOLD = /need --hold/;
const SEED_SIZES = /default or large/;
const run = (p95) => ({ keyToFrameP95Ms: p95 });
const at = (user, idle) => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
const w = (url, type, start, waitedOn, status = 200) => ({ url, type, start, waitedOn, status });

void test("--only matches scenario names and paths, and prefixes select the profile passes", () => {
	assert.equal(matchesOnly([], "anything"), true);
	assert.equal(matchesOnly(["typing"], "editor typing", "/_emdash/admin/content/posts/1"), true);
	assert.equal(matchesOnly(["media"], "upload media", null), true);
	assert.equal(matchesOnly(["media"], "editor typing", "/_emdash/admin/content/posts/1"), false);
	assert.deepEqual(
		filterTargets(
			[
				{ name: "admin media library", path: "/_emdash/admin/media" },
				{ name: "public home", path: "/" },
			],
			["media"],
		).map((t) => t.name),
		["admin media library"],
	);
	assert.equal(passSelected([], "write"), true);
	assert.equal(passSelected(["media"], "write"), false);
	assert.equal(passSelected(["writes"], "write"), true);
	assert.equal(passSelected(["plan"], "write"), false);
});

void test("compare screenshots go to their own folder", () => {
	assert.equal(screenshotRoot("/r", "primary", "p"), "/r/screenshots/p");
	assert.equal(screenshotRoot("/r", "compare", "p"), "/r/screenshots-compare/p");
});

void test("hold-after-boot only waits for the boot requests on signed-in admin screens", () => {
	const options = parseArgs(["--hold", "/_emdash/api/", "--hold-after-boot"]);
	assert.deepEqual(holdTriggers(options, { kind: "admin" }), ADMIN_BOOT_REQUESTS);
	assert.deepEqual(holdTriggers(options, { kind: "admin", signedOut: true }), []);
	assert.deepEqual(holdTriggers(options, { kind: "public" }), []);
	const explicit = parseArgs(["--hold", "/api/", "--hold-after", "/api/menus"]);
	assert.deepEqual(holdTriggers(explicit, { kind: "public" }), ["/api/menus"]);
	assert.deepEqual(distortingOptions(explicit), ["--hold /api/ --hold-after /api/menus"]);
	assert.throws(() => parseArgs(["--hold-after-boot"]), NEEDS_HOLD);
});

void test("new options parse with defaults", () => {
	const defaults = parseArgs([]);
	assert.equal(defaults.seedSize, "default");
	assert.equal(defaults.skipWrites, false);
	assert.equal(defaults.thresholds.writeWaves, 1);
	const options = parseArgs([
		"--seed-size",
		"large",
		"--skip-writes",
		"--threshold-write-waves",
		"2",
		"--threshold-write-ttfb=30",
		"--threshold-write-queries",
		"3",
	]);
	assert.equal(options.seedSize, "large");
	assert.equal(options.skipWrites, true);
	assert.deepEqual(
		[
			options.thresholds.writeWaves,
			options.thresholds.writeTtfbPercent,
			options.thresholds.writeQueries,
		],
		[2, 30, 3],
	);
	assert.throws(() => parseArgs(["--seed-size", "huge"]), SEED_SIZES);
});

void test("duplicate queries group by normalized text and count identical parameters", () => {
	const events = [
		{ sql: "select * from ec_posts where id = ?", params: ["a"] },
		{ sql: "select *  from ec_posts\n where id = ?", params: ["a"] },
		{ sql: "select * from ec_posts where id = ?", params: ["b"] },
		{ sql: "select * from media where id in (?, ?)", params: [1, 2] },
		{ sql: "select * from media where id in (?)", params: [3] },
		{ sql: "begin", params: [] },
		{ sql: "begin", params: [] },
		{ sql: "select 1", params: [] },
	];
	assert.deepEqual(duplicateQueries(events), [
		{ sql: "select * from ec_posts where id = ?", count: 3, sameParams: 2 },
		{ sql: "select * from media where id in (...)", count: 2, sameParams: 0 },
	]);
});

const write = (over = {}) => ({
	op: "publish",
	queries: 20,
	ttfbMs: 100,
	dbWaves: 18,
	dbRoundTrips: 20,
	afterResponse: { ms: 50, roundTrips: 4 },
	...over,
});

const writeProfile = (writes) => ({ profile: "blog-node-postgres", pages: [], writes });

void test("writes regress on one more wave or query, TTFB over 20% and 10 ms, or more round trips in all", () => {
	const compare = (before, after) =>
		compareResults([writeProfile([before])], [writeProfile([after])], DEFAULT_THRESHOLDS)
			.regressions.map((r) => r.metric)
			.toSorted((a, b) => a.localeCompare(b));
	assert.deepEqual(compare(write(), write()), []);
	assert.deepEqual(compare(write(), write({ dbWaves: 19 })), ["DB waves"]);
	assert.deepEqual(compare(write(), write({ queries: 21 })), ["queries"]);
	assert.deepEqual(compare(write(), write({ ttfbMs: 125 })), ["TTFB ms"]);
	assert.deepEqual(compare(write({ ttfbMs: 20 }), write({ ttfbMs: 29 })), []);
	assert.deepEqual(compare(write(), write({ afterResponse: { ms: 60, roundTrips: 5 } })), [
		"total round trips",
	]);
	const deferred = write({
		queries: 10,
		dbWaves: 8,
		dbRoundTrips: 10,
		afterResponse: { ms: 400, roundTrips: 12 },
	});
	assert.deepEqual(compare(write(), deferred), [], "work moved after the response is not flagged");
	const sqlite = { dbWaves: undefined, afterResponse: { ms: 3, commits: 2 } };
	assert.deepEqual(compare(write(sqlite), write({ ...sqlite, queries: 20 })), []);
	const rows = compareResults(
		[writeProfile([write()])],
		[writeProfile([write()])],
		DEFAULT_THRESHOLDS,
	).rows;
	assert.ok(rows.every((r) => r.where === "write publish"));
});

void test("typing regresses only when every run in the new workspace is slow", () => {
	const before = { keyToFrameP95Ms: 39 };
	assert.equal(
		typingRegressed(before, { keyToFrameP95Ms: 60, samples: [run(132), run(60)] }),
		true,
	);
	assert.equal(
		typingRegressed(before, { keyToFrameP95Ms: 24, samples: [run(132), run(24)] }),
		false,
	);
	assert.equal(
		typingRegressed(before, { keyToFrameP95Ms: 45, samples: [run(45), run(48)] }),
		false,
	);
	assert.equal(typingRegressed(before, { keyToFrameP95Ms: 132 }), true);
});

void test("the best of repeated runs keeps the fastest timings but not hidden movement", () => {
	const runs = [
		{
			keyToFrameP95Ms: 132,
			passed: false,
			moved: [{ element: "div", delta: 4 }],
			cls: 0.01,
			summary: "slow",
			machineLoad: { cpuBusyPercent: 90 },
		},
		{
			keyToFrameP95Ms: 24,
			passed: true,
			moved: [],
			cls: 0,
			summary: "fast",
			machineLoad: { cpuBusyPercent: 30 },
		},
	];
	const best = bestOfSamples(runs);
	assert.equal(best.keyToFrameP95Ms, 24);
	assert.equal(best.passed, false);
	assert.equal(best.moved.length, 1);
	assert.equal(best.cls, 0.01);
	assert.deepEqual(
		best.samples.map((s) => s.keyToFrameP95Ms),
		[132, 24],
	);
	assert.ok(
		best.summary.endsWith("; best of 2 runs (p95 132 and 24 ms, machine CPU busy 90% and 30%)"),
	);
	const failed = [
		{ passed: null, error: "boom" },
		{ passed: null, error: "boom" },
	];
	assert.equal(bestOfSamples(failed).error, "boom");
});

void test("busy percent is the share of non-idle CPU time across cores", () => {
	assert.equal(busyPercent(at(0, 0), at(30, 70)), 30);
	assert.equal(busyPercent(at(10, 10), at(10, 10)), null);
});

void test("late discovery flags critical scripts found by parsing another script", () => {
	const waterfall = [
		w("/admin", "Document", 0, null),
		w("/a.js", "Script", 10, "/admin"),
		w("/preloaded.js", "Script", 11, "/admin"),
		w("/b.js", "Script", 40, "/a.js"),
		w("/c.css", "Stylesheet", 60, "/b.js"),
		w("/late.js", "Script", 900, "/a.js"),
		w("/api", "Fetch", 500, "/b.js"),
		w("/broken.js", "Script", 50, "/a.js", 404),
	];
	const found = lateDiscoveries(waterfall, 500);
	assert.deepEqual(
		found.map((f) => [f.url, f.discoveredBy, f.chain]),
		[
			["/b.js", "/a.js", ["/admin", "/a.js", "/b.js"]],
			["/c.css", "/b.js", ["/admin", "/a.js", "/b.js", "/c.css"]],
		],
	);
	assert.equal(lateDiscoveries(waterfall, null).length, 3);
});

const encodeVlq = (value) => {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let v = value < 0 ? (-value << 1) | 1 : value << 1;
	let out = "";
	do {
		let digit = v & 31;
		v >>>= 5;
		if (v > 0) digit |= 32;
		out += chars[digit];
	} while (v > 0);
	return out;
};

void test("source map decoding attributes generated bytes to sources", () => {
	assert.deepEqual(decodeMappings("AAAA,KACA;;EAAA"), [
		[
			[0, 0, 0, 0],
			[5, 0, 1, 0],
		],
		[],
		[[2, 0, 1, 0]],
	]);
	// Line 0: "import x;" before any segment, then columns 9-14 from react, 15+ from the app.
	// Line 1: indentation before an app segment. Line 2: no segments, continues the app.
	// Line 3: a segment without a source.
	const mappings = [
		`${encodeVlq(9)}AAAA,${encodeVlq(6)}${encodeVlq(1)}AAA`,
		`${encodeVlq(1)}AAAA`,
		"",
		"A",
	].join(";");
	const map = { sources: ["../node_modules/react/index.js", "../src/app.js"], mappings };
	const totals = attributeFile("import x;reactsapp\n\tcall()\n}\nglue", map);
	assert.equal(totals.get("(unmapped)").bytes, "import x;".length + "glue".length);
	assert.equal(totals.get("../node_modules/react/index.js").bytes, 6);
	assert.equal(totals.get("../src/app.js").bytes, "app\n\tcall()\n}\n".length);
});

void test("a workspace package's own source map credits its original modules", () => {
	const workspace = mkdtempSync(join(tmpdir(), "perf-composition-"));
	try {
		const dist = join(workspace, "packages/admin/dist");
		mkdirSync(dist, { recursive: true });
		writeFileSync(join(dist, "index.js"), "aaaa\nbbbb\n");
		writeFileSync(
			join(dist, "index.js.map"),
			JSON.stringify({ sources: ["../src/A.tsx", "../src/B.tsx"], mappings: "AAAA;ACAA" }),
		);
		const siteDir = join(workspace, "site");
		const mapDir = join(siteDir, "dist/client/_astro");
		const outer = {
			sources: ["../../../../packages/admin/dist/index.js"],
			mappings: `AAAA,${encodeVlq(4)}ACAA`,
		};
		const comp = composeFiles([{ code: "xxxxyyyy", map: outer, mapDir }], { siteDir, workspace });
		assert.deepEqual(
			comp.modules
				.map((m) => [m.module, m.package, m.bytes])
				.toSorted((a, b) => a[0].localeCompare(b[0])),
			[
				["packages/admin/src/A.tsx", "packages/admin", 4],
				["packages/admin/src/B.tsx", "packages/admin", 4],
			],
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

void test("sources are classified into the site, workspace packages and dependencies", () => {
	const context = {
		siteDir: "/ws/.perf-audit/work/x/sites/p",
		workspace: "/ws",
		mapDir: "/ws/.perf-audit/work/x/sites/p/dist/client/_astro",
	};
	assert.deepEqual(classifySource("../../../src/pages/index.astro", context), {
		module: "src/pages/index.astro",
		package: "(site)",
	});
	assert.deepEqual(
		classifySource(
			"../../../../../../../../node_modules/.pnpm/@phosphor-icons+react@2.1.7/node_modules/@phosphor-icons/react/dist/csr/Acorn.mjs",
			context,
		),
		{ module: "@phosphor-icons/react/dist/csr/Acorn.mjs", package: "@phosphor-icons/react" },
	);
	assert.deepEqual(
		classifySource("../../../../../../../../packages/admin/dist/index.js", context),
		{ module: "packages/admin/dist/index.js", package: "packages/admin" },
	);
	assert.equal(classifySource("\0virtual:emdash/config", context).package, "(virtual modules)");
	const comp = composeFiles(
		[
			{
				code: "abcdefghij",
				map: { sources: ["../../../src/a.js"], mappings: "AAAA" },
				mapDir: context.mapDir,
			},
			{ code: "no map here", map: null, mapDir: null },
		],
		context,
	);
	assert.equal(comp.mappedFiles, 1);
	assert.deepEqual(
		comp.packages.map((p) => [p.package, p.bytes]),
		[
			["(unmapped)", 11],
			["(site)", 10],
		],
	);
});

void test("composition deltas name the packages that changed", () => {
	const before = { packages: [{ package: "react-dom", bytes: 500_000 }] };
	const after = {
		packages: [
			{ package: "react-dom", bytes: 501_000 },
			{ package: "packages/admin", bytes: 900_000 },
		],
	};
	assert.deepEqual(compositionDeltas(before, after), [
		{ package: "packages/admin", before: 0, after: 900_000, delta: 900_000 },
	]);
	const deltas = bundleDeltas(
		[{ profile: "p", bundleComposition: { server: before } }],
		[{ profile: "p", bundleComposition: { server: after } }],
	);
	assert.equal(deltas[0].bundle, "server");
	assert.equal(deltas[0].deltas[0].package, "packages/admin");
});

void test("the source-map config wraps the profile's own config", () => {
	const config = sourceMapConfig("source.mjs");
	assert.ok(config.includes('import config from "./source.mjs";'));
	assert.ok(config.includes('sourcemap: "hidden"'));
	assert.ok(config.includes("...config.vite?.build"));
});

void test("the large seed is deterministic with realistic shares, translations and dates", () => {
	const now = Date.parse("2026-11-11T00:00:00Z");
	const rows = bulkEntries(20_000, { now });
	assert.deepEqual(bulkEntries(50, { now }), bulkEntries(50, { now }));
	assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
	const share = (pred) => rows.filter(pred).length / rows.length;
	for (const [status, pct] of STATUS_SHARES) {
		const actual =
			status === "trashed"
				? share((r) => r.deletedAt)
				: share((r) => !r.deletedAt && r.status === status);
		assert.ok(Math.abs(actual * 100 - pct) < 1.5, `${status}: ${actual}`);
	}
	for (const [locale, pct] of LOCALE_SHARES) {
		assert.ok(Math.abs(share((r) => r.locale === locale) * 100 - pct) < 1.5, locale);
	}
	const keys = rows.map((r) => `${r.slug}|${r.locale}`);
	assert.equal(new Set(keys).size, rows.length, "slug is unique per locale");
	const groups = rows.map((r) => `${r.translationGroup}|${r.locale}`);
	assert.equal(new Set(groups).size, rows.length, "one row per locale per group");
	const fr = rows.filter((r) => r.locale === "fr");
	assert.ok(
		fr.every((r) => r.translationGroup !== r.id),
		"translations join an English group",
	);
	assert.ok(rows.every((r) => r.createdAt.getTime() <= now && r.updatedAt >= r.createdAt));
	assert.ok(rows.filter((r) => r.status === "scheduled").every((r) => r.scheduledAt > now));
	assert.ok(rows.filter((r) => r.status !== "published").every((r) => r.publishedAt === null));
	const recent = share((r) => now - r.createdAt.getTime() < 365 * 24 * 3600_000);
	assert.ok(recent > 0.3, "more entries in recent years");
	assert.ok(rows[0].createdAt <= rows.at(-1).createdAt, "oldest first");
});

void test("large seed rows are inserted in parameter-bounded batches", () => {
	const rows = Array.from({ length: 5 }, (_, i) => ({
		id: `x${i}`,
		slug: `s${i}`,
		extra: "ignored",
	}));
	const statements = insertStatements("ec_posts", ["id", "slug"], rows, 2);
	assert.equal(statements.length, 3);
	assert.equal(statements[0].text, 'INSERT INTO ec_posts ("id", "slug") VALUES (?, ?), (?, ?)');
	assert.deepEqual(statements[2].params, ["x4", "s4"]);
	assert.equal(formatLike("2026-01-01T00:00:00.000Z", new Date(0)), "1970-01-01T00:00:00.000Z");
	assert.equal(formatLike("2026-01-01 00:00:00", new Date(0)), "1970-01-01 00:00:00");
});

void test("plans flag sequential scans and sorts over large tables only", () => {
	const plan = {
		Plan: {
			"Node Type": "Limit",
			"Actual Rows": 20,
			Plans: [
				{
					"Node Type": "Sort",
					"Sort Method": "top-N heapsort",
					"Actual Rows": 20,
					Plans: [{ "Node Type": "Seq Scan", "Relation Name": "ec_posts", "Actual Rows": 39_000 }],
				},
			],
		},
	};
	const { flags, nodes } = planFlags(plan, { ec_posts: 50_000 });
	assert.deepEqual(flags, [
		{ kind: "sort", rows: 39_000, method: "top-N heapsort" },
		{ kind: "seq scan", relation: "ec_posts", tableRows: 50_000 },
	]);
	assert.equal(nodes[2], "Seq Scan on ec_posts (39000 rows)");
	assert.deepEqual(planFlags(plan, { ec_posts: 60 }, 10_000).flags.length, 1);
	const small = structuredClone(plan);
	small.Plan.Plans[0].Plans[0]["Actual Rows"] = 60;
	assert.deepEqual(planFlags(small, { ec_posts: 60 }).flags, []);
	assert.equal(queryKind('select count(*) as "n" from ec_posts', "list"), "count");
	assert.equal(queryKind("select * from ec_posts", "archive"), "archive");
	const requests = planRequests({
		collection: "posts",
		publicTargets: [
			{ name: "public home", path: "/" },
			{ name: "public entry (most images)", path: "/posts/a" },
			{ name: "public archive development", path: "/category/development" },
		],
	});
	assert.deepEqual(
		requests.map((r) => `${r.kind} ${r.path}`),
		[
			"list /",
			"entry /posts/a",
			"archive /category/development",
			"list /_emdash/api/content/posts?limit=20",
			"sitemap /sitemap-posts.xml",
			"count /_emdash/api/dashboard",
			"sitemap /sitemap.xml",
		],
	);
});
