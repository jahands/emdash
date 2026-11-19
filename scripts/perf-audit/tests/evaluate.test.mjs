import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_THRESHOLDS } from "../lib/args.mjs";
import {
	compareResults,
	confirmationPlan,
	confirmRegressions,
	evaluateBudgets,
	median,
} from "../lib/evaluate.mjs";
import { RestoreLedger, writeStatements } from "../lib/ledger.mjs";

const page = (over = {}) => ({
	name: "admin media library",
	viewport: "desktop",
	url: "/_emdash/admin/media",
	status: 200,
	cls: 0.01,
	api: { count: 8 },
	bytesByType: { Image: 200_000 },
	oversizedImages: [],
	...over,
});

const profile = (over = {}) => ({
	profile: "blog-workerd-d1",
	build: { server: { gzipBytes: 1_000_000 }, upload: { uploadGzipBytes: 2_000_000 } },
	initialAdminJs: { gzipBytes: 500_000 },
	coldStart: { publicPage: { ttfbMs: 200 }, adminApi: { ttfbMs: 100 } },
	pages: [page()],
	scenarios: [{ name: "editor typing (desktop)", cls: 0, keyToFrameP95Ms: 30 }],
	...over,
});

void test("budgets fail on CLS, server gzip, initial JS and oversized images", () => {
	const p = profile({
		pages: [page({ cls: 0.2, oversizedImages: [{ src: "a" }, { src: "b" }] })],
	});
	const failures = evaluateBudgets([p], {
		cls: 0.1,
		serverGzipKiB: 1000,
		initialJsGzipKiB: 1000,
		oversizedImages: 1,
	});
	assert.deepEqual(
		failures.map((f) => f.budget),
		["max-cls", "max-server-gz", "max-oversized-images"],
	);
	assert.equal(failures[1].actual, 1953);
	assert.deepEqual(evaluateBudgets([p], {}), []);
});

void test("the upload budget applies to what wrangler would upload", () => {
	const failures = evaluateBudgets(
		[profile(), profile({ build: { server: { gzipBytes: 5_000_000 } } })],
		{
			uploadGzipKiB: 1900,
		},
	);
	assert.deepEqual(
		failures.map((f) => [f.profile, f.budget, f.actual]),
		[["blog-workerd-d1", "max-upload-gz", 1953]],
	);
});

void test("identical results compare without regressions", () => {
	const { rows, regressions } = compareResults([profile()], [profile()], DEFAULT_THRESHOLDS);
	assert.ok(rows.length > 0);
	assert.deepEqual(regressions, []);
});

void test("compare flags each metric past its threshold", () => {
	const after = profile({
		build: { server: { gzipBytes: 1 }, upload: { uploadGzipBytes: 2_200_000 } },
		coldStart: { publicPage: { ttfbMs: 260 }, adminApi: { ttfbMs: 110 } },
		pages: [
			page({
				cls: 0.025,
				api: { count: 10 },
				bytesByType: { Image: 260_000 },
				oversizedImages: [{ src: "a" }],
			}),
		],
		scenarios: [{ name: "editor typing (desktop)", cls: 0.05, keyToFrameP95Ms: 60 }],
	});
	const { regressions } = compareResults([profile()], [after], DEFAULT_THRESHOLDS);
	assert.deepEqual(regressions.map((r) => `${r.where}: ${r.metric}`).toSorted(), [
		"build: server gzip bytes",
		"cold start: publicPage ttfb ms",
		"desktop admin media library: API requests",
		"desktop admin media library: CLS",
		"desktop admin media library: image bytes",
		"desktop admin media library: oversized images",
		"scenario editor typing (desktop): CLS",
		"scenario editor typing (desktop): input-to-frame p95 ms",
	]);
});

void test("small changes stay under the thresholds", () => {
	const after = profile({
		pages: [page({ cls: 0.019, api: { count: 9 }, bytesByType: { Image: 230_000 } })],
		coldStart: { publicPage: { ttfbMs: 240 }, adminApi: { ttfbMs: 120 } },
	});
	assert.deepEqual(compareResults([profile()], [after], DEFAULT_THRESHOLDS).regressions, []);
});

void test("typing latency is a regression only past the frame budget", () => {
	const typing = (keyToFrameP95Ms) =>
		profile({ scenarios: [{ name: "editor typing (desktop)", cls: 0, keyToFrameP95Ms }] });
	const regressed = (before, after) =>
		compareResults([typing(before)], [typing(after)], DEFAULT_THRESHOLDS).regressions.length > 0;
	assert.equal(regressed(20, 45), false);
	assert.equal(regressed(50, 60), false);
	assert.equal(regressed(30, 60), true);
});

void test("the ledger restores only after a measurement wrote state", () => {
	const ledger = new RestoreLedger("seeded");
	assert.equal(ledger.record("desktop public home", { observedSql: ["select 1"] }), false);
	assert.equal(ledger.needsRestore(), false);
	ledger.record("desktop admin editor", {
		observedSql: ['insert into "_emdash_entry_locks" values (?)', "select 1"],
	});
	assert.equal(ledger.needsRestore(), true);
	ledger.restored("desktop admin media library", 250.4);
	assert.equal(ledger.needsRestore(), false);
	ledger.record("upload media", { declaredWrites: true });
	assert.deepEqual(ledger.toJSON().restores, [
		{
			snapshot: "seeded",
			before: "desktop admin media library",
			after: "desktop admin editor",
			ms: 250,
		},
	]);
	assert.deepEqual(
		ledger.toJSON().writes.map((w) => [w.measurement, w.statements, w.declared]),
		[
			["desktop admin editor", 1, false],
			["upload media", 0, true],
		],
	);
});

void test("write detection ignores reads", () => {
	assert.deepEqual(
		writeStatements([
			"SELECT * FROM x",
			"  UPDATE x SET a = 1",
			"with t as (select 1) select * from t",
			"WITH claimed AS (SELECT 1) UPDATE work SET state = 'done'",
			"DELETE FROM y",
		]),
		[
			"  UPDATE x SET a = 1",
			"WITH claimed AS (SELECT 1) UPDATE work SET state = 'done'",
			"DELETE FROM y",
		],
	);
});

const sample = (cls) => ({ cls, apiCount: 8, imageBytes: 200_000, oversized: 0 });

void test("a candidate that does not hold up on medians is not reported", () => {
	const before = [profile()];
	const after = [
		profile({
			pages: [page({ cls: 0.06 })],
			coldStart: { publicPage: { ttfbMs: 300 }, adminApi: { ttfbMs: 100 } },
		}),
	];
	const { regressions } = compareResults(before, after, DEFAULT_THRESHOLDS);
	assert.equal(regressions.length, 2);
	const plan = confirmationPlan(regressions);
	assert.deepEqual(plan.get("blog-workerd-d1"), {
		pages: [{ viewport: "desktop", name: "admin media library" }],
		coldStart: true,
		writes: false,
	});
	const confirmed = confirmRegressions(
		regressions,
		before,
		after,
		{
			"blog-workerd-d1": {
				pages: { "desktop admin media library": [sample(0.06), sample(0.06)] },
				coldStart: [
					{ publicPage: { ttfbMs: 290 }, adminApi: { ttfbMs: 100 } },
					{ publicPage: { ttfbMs: 310 }, adminApi: { ttfbMs: 100 } },
				],
			},
		},
		{
			"blog-workerd-d1": {
				pages: { "desktop admin media library": [sample(0.01), sample(0.06)] },
				coldStart: [
					{ publicPage: { ttfbMs: 205 }, adminApi: { ttfbMs: 100 } },
					{ publicPage: { ttfbMs: 320 }, adminApi: { ttfbMs: 100 } },
				],
			},
		},
		DEFAULT_THRESHOLDS,
	);
	assert.deepEqual(
		confirmed.map((c) => [c.where, c.confirmed, c.medianBefore, c.medianAfter]),
		[
			["cold start", false, 290, 300],
			["desktop admin media library", false, 0.06, 0.06],
		],
	);
});

void test("a regression that holds on medians stays confirmed", () => {
	const before = [profile()];
	const after = [profile({ pages: [page({ cls: 0.08 })] })];
	const { regressions } = compareResults(before, after, DEFAULT_THRESHOLDS);
	const key = "desktop admin media library";
	const [row] = confirmRegressions(
		regressions,
		before,
		after,
		{ "blog-workerd-d1": { pages: { [key]: [sample(0.01), sample(0.012)] } } },
		{ "blog-workerd-d1": { pages: { [key]: [sample(0.08), sample(0.075)] } } },
		DEFAULT_THRESHOLDS,
	);
	assert.equal(row.confirmed, true);
	assert.equal(median([3, 1, 2, 10]), 2.5);
});
