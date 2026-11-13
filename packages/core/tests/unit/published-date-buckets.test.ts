import { sql, type Kysely, type KyselyPlugin, type QueryId } from "kysely";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../src/loader.js");
	return {
		getLiveCollection: vi.fn(
			(_collection: string, filter: import("../../src/loader.js").CollectionFilter) =>
				emdashLoader().loadCollection!({ filter }),
		),
		getLiveEntry: vi.fn(),
	};
});

import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import {
	__setObjectCacheBackendForTests,
	cachedQuery,
	contentCacheNamespaces,
	invalidateCollectionCache,
	invalidateObjectCache,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { getEmDashCollection, getPublishedDateBuckets } from "../../src/query.js";
import { runWithContext, type EmDashRequestContext } from "../../src/request-context.js";
import { groupPublishedDateBuckets } from "../../src/widgets/archives.js";
import { createPostFixture } from "../utils/fixtures.js";
import {
	describeEachDialect,
	destroySharedPool,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

const march = "2026-03-15T12:00:00.000Z";
const april = "2026-04-15T12:00:00.000Z";
const may = "2026-05-15T12:00:00.000Z";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
}

/**
 * The published dates the Archives widget grouped before they were bucketed
 * in the database: main's `loadPublishedDates` query and `getPublishedDates`
 * parsing, unchanged. A value without an offset parses in the current time
 * zone, so parse under the zone being compared.
 */
async function loadPublishedAtLikeMain(db: Kysely<Database>) {
	const result = await sql<{ published_at: string | null }>`
		SELECT published_at FROM ec_post
		WHERE deleted_at IS NULL AND status = 'published'
		ORDER BY published_at DESC, id DESC
	`.execute(db);
	return result.rows;
}

function parseLikeMain(rows: Array<{ published_at: string | null }>): Date[] {
	const dates: Date[] = [];
	for (const row of rows) {
		if (row.published_at) {
			const date = new Date(row.published_at);
			if (!Number.isNaN(date.getTime())) dates.push(date);
		}
	}
	return dates;
}

/** Main's `groupEntriesByPublishedAt`, unchanged apart from taking dates. */
function groupLikeMain(
	dates: Date[],
	options: { type?: "monthly" | "yearly"; limit?: number } = {},
) {
	const type = options.type ?? "monthly";
	const limit = options.limit ?? 12;
	const archives = new Map<string, { date: Date; count: number; url: string }>();
	for (const date of dates) {
		let key: string;
		let url: string;
		if (type === "yearly") {
			const year = date.getFullYear();
			key = `${year}`;
			url = `/archives/${year}`;
		} else {
			const year = date.getFullYear();
			const month = date.getMonth() + 1;
			key = `${year}-${month.toString().padStart(2, "0")}`;
			url = `/archives/${year}/${month.toString().padStart(2, "0")}`;
		}
		const existing = archives.get(key);
		if (existing) {
			existing.count++;
		} else {
			archives.set(key, { date, count: 1, url });
		}
	}
	return [...archives.values()].slice(0, limit).map(({ date, count, url }) => ({
		label:
			type === "yearly"
				? `${date.getFullYear()}`
				: date.toLocaleDateString("en-US", { year: "numeric", month: "long" }),
		count,
		url,
	}));
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * UTC offsets, current and historical, whose month boundaries the boundary
 * dataset straddles: quarter hours, the +14 and -11 extremes, and the
 * seconds-precise mean time offsets of Amsterdam (+0:19:32, until 1937) and
 * Monrovia (-0:44:30, until 1972).
 */
const OFFSETS = [
	0,
	15 * MINUTE,
	19 * MINUTE + 32_000,
	30 * MINUTE,
	44 * MINUTE + 30_000,
	45 * MINUTE,
	HOUR,
	2 * HOUR,
	3 * HOUR,
	3.5 * HOUR,
	5.5 * HOUR,
	5.75 * HOUR,
	9.5 * HOUR,
	10.5 * HOUR,
	11 * HOUR,
	12 * HOUR,
	12.75 * HOUR,
	13 * HOUR,
	13.75 * HOUR,
	14 * HOUR,
];

/** Instants at and around every month boundary of `years` under each of {@link OFFSETS}. */
function boundaryDates(years: number[]): string[] {
	const dates: string[] = [];
	for (const year of years) {
		for (let month = 0; month < 12; month++) {
			const boundary = Date.UTC(year, month, 1);
			for (const offset of OFFSETS) {
				for (const sign of [1, -1]) {
					for (const nudge of [-1, 0, 1, 999, 1000]) {
						dates.push(new Date(boundary + sign * offset + nudge).toISOString());
					}
				}
			}
			dates.push(new Date(Date.UTC(year, month, 14, 9, 26, 53, 589)).toISOString());
		}
	}
	return dates;
}

/** Instants either side of daylight saving transitions in the tested zones. */
const DST_TRANSITIONS = [
	"2026-03-08T07:00:00.000Z",
	"2026-11-01T06:00:00.000Z",
	"2018-11-04T03:00:00.000Z",
	"2018-02-18T02:00:00.000Z",
	"2025-04-05T15:00:00.000Z",
	"2025-10-04T16:00:00.000Z",
	"2025-03-09T05:00:00.000Z",
	"2025-11-02T05:00:00.000Z",
].flatMap((transition) =>
	[-HOUR, -1000, -1, 0, 1, 1000, HOUR].map((nudge) =>
		new Date(Date.parse(transition) + nudge).toISOString(),
	),
);

/** Values main parsed with `new Date()` that aren't canonical UTC timestamps. */
const NON_CANONICAL_DATES = [
	"",
	"not-a-date",
	"2024-01-01",
	"2024-01-31T23:30:00",
	"2024-01-31T23:30:00-05:00",
	"2024-02-01T00:00:00+14:00",
	"2024-03-01T00:00:00Z",
	"2024-02-29T23:59:59Z",
	"2024-06-01 00:00:00",
	"2024-04-30t23:30:00.000z",
	"2024-05-01T00:15:00.000z",
	"2024-05-15t12:00:00Z",
	"2024-05-15T12:00:00+0Z",
];

const TIME_ZONES = [
	"UTC",
	"America/New_York",
	"America/Sao_Paulo",
	"America/Havana",
	"America/St_Johns",
	"Asia/Kolkata",
	"Asia/Kathmandu",
	"Australia/Lord_Howe",
	"Pacific/Chatham",
	"Pacific/Kiritimati",
	"Pacific/Pago_Pago",
	"Africa/Monrovia",
	"Europe/Amsterdam",
	"Europe/Dublin",
];

const originalTimeZone = process.env.TZ;

function useTimeZone(timeZone: string | undefined) {
	if (timeZone === undefined) delete process.env.TZ;
	else process.env.TZ = timeZone;
}

afterAll(destroySharedPool);

describeEachDialect("published date buckets", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let queries: Array<{ sql: string; fields?: string[]; rows?: number }>;
	let failNextRead: boolean;

	beforeEach(async () => {
		useTimeZone("UTC");
		ctx = await setupForDialectWithCollections(dialect);
		__setObjectCacheBackendForTests(null);
		setI18nConfig(null);
		queries = [];
		failNextRead = false;
		const reads = new Map<QueryId, (typeof queries)[number]>();
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				const compiled = ctx.db.getExecutor().compileQuery(args.node, args.queryId);
				if (/^\s*(SELECT|WITH)\b/i.test(compiled.sql)) {
					const query = { sql: compiled.sql };
					queries.push(query);
					reads.set(args.queryId, query);
				}
				return args.node;
			},
			async transformResult(args) {
				const query = reads.get(args.queryId);
				if (query) {
					query.fields = Object.keys(args.result.rows[0] ?? {}).toSorted();
					query.rows = args.result.rows.length;
					if (failNextRead && query.sql.includes("ec_post")) {
						failNextRead = false;
						throw new Error("Content read failed");
					}
				}
				return args.result;
			},
		};
		db = ctx.db.withPlugin(plugin);
	});

	afterEach(async () => {
		useTimeZone(originalTimeZone);
		await teardownForDialect(ctx);
		__setObjectCacheBackendForTests(null);
		setI18nConfig(null);
		vi.clearAllMocks();
	});

	async function seed(
		slug: string,
		publishedAt: string | null,
		options: { locale?: string; status?: string; deletedAt?: string; updatedAt?: string } = {},
	) {
		const item = await new ContentRepository(ctx.db).create(
			createPostFixture({ slug, status: "published", locale: options.locale ?? "en" }),
		);
		await sql`
			UPDATE ec_post SET published_at = ${publishedAt},
				updated_at = ${options.updatedAt ?? march}, status = ${options.status ?? "published"},
				deleted_at = ${options.deletedAt ?? null}
			WHERE id = ${item.id}
		`.execute(ctx.db);
		return item.id;
	}

	function read(options?: { locale?: string }, context: Partial<EmDashRequestContext> = {}) {
		return runWithContext({ editMode: false, db, ...context }, () =>
			getPublishedDateBuckets("post", options),
		);
	}

	/** Insert published posts directly, many rows per statement. */
	async function seedMany(dates: string[]) {
		for (let start = 0; start < dates.length; start += 500) {
			const rows = dates.slice(start, start + 500).map((publishedAt, index) => ({
				id: `bulk-${start + index}`,
				slug: `bulk-${start + index}`,
				status: "published",
				locale: "en",
				published_at: publishedAt,
			}));
			await sql`
				INSERT INTO ec_post (id, slug, status, locale, published_at)
				VALUES ${sql.join(
					rows.map(
						(row) =>
							sql`(${row.id}, ${row.slug}, ${row.status}, ${row.locale}, ${row.published_at})`,
					),
				)}
			`.execute(ctx.db);
		}
	}

	async function expectMainGrouping(
		timeZones: string[],
		buckets: Array<{ bucket: string; count: number }>,
	) {
		const rows = await loadPublishedAtLikeMain(ctx.db);
		for (const timeZone of timeZones) {
			useTimeZone(timeZone);
			const dates = parseLikeMain(rows);
			for (const type of ["monthly", "yearly"] as const) {
				for (const limit of [1, 12, 10_000]) {
					expect(
						groupPublishedDateBuckets(buckets, { type, limit }),
						`${timeZone} ${type} limit ${limit}`,
					).toEqual(groupLikeMain(dates, { type, limit }));
				}
			}
		}
	}

	async function enableCache() {
		await waitForDeferredTasks();
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });
	}

	const contentReads = () => queries.filter((query) => query.sql.includes("ec_post"));
	const bucketKeys = (buckets: Array<{ bucket: string }>) => buckets.map(({ bucket }) => bucket);

	it("counts published entries per date bucket in one query", async () => {
		await seed("march-first", march);
		await seed("april", april);
		await seed("march-second", "2026-03-20T12:00:00.000Z");
		await seed("march-second-twin", "2026-03-20T18:00:00.000Z");
		await seed("previous-year", "2025-12-15T12:00:00.000Z");
		await seed("draft", may, { status: "draft", updatedAt: "2030-01-01T12:00:00.000Z" });
		await seed("archived", may, { status: "archived" });
		await seed("deleted", may, { deletedAt: march });
		const past = await seed("scheduled-past", may, { status: "scheduled" });
		const future = await seed("scheduled-future", may, { status: "scheduled" });
		await sql`UPDATE ec_post SET scheduled_at = '2000-01-01T00:00:00.000Z' WHERE id = ${past}`.execute(
			ctx.db,
		);
		await sql`UPDATE ec_post SET scheduled_at = '2100-01-01T00:00:00.000Z' WHERE id = ${future}`.execute(
			ctx.db,
		);

		const result = await read();
		expect(result.error).toBeUndefined();
		expect(result.buckets).toEqual([
			{ bucket: "2026-04-15", count: 1 },
			{ bucket: "2026-03-20", count: 2 },
			{ bucket: "2026-03-15", count: 1 },
			{ bucket: "2025-12-15", count: 1 },
		]);
		expect(result.cacheHint).toEqual({ tags: ["post"] });
		expect(groupPublishedDateBuckets(result.buckets, { limit: 2 })).toEqual([
			{ label: "April 2026", count: 1, url: "/archives/2026/04" },
			{ label: "March 2026", count: 3, url: "/archives/2026/03" },
		]);
		expect(groupPublishedDateBuckets(result.buckets, { type: "yearly" })).toEqual([
			{ label: "2026", count: 4, url: "/archives/2026" },
			{ label: "2025", count: 1, url: "/archives/2025" },
		]);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.fields).toEqual(["bucket", "count"]);
		expect(queries[0]?.rows).toBe(4);
	});

	it("groups exactly like the server's local time zone did, across month boundaries and transitions", async () => {
		const dates = [
			...boundaryDates([1930, 1955, 2018, 2024, 2026]),
			...DST_TRANSITIONS,
			...NON_CANONICAL_DATES,
		];
		await seedMany(dates);
		await seed("draft", "2019-06-01T00:00:00.000Z", { status: "draft" });
		await seed("deleted", "2019-07-01T00:00:00.000Z", { deletedAt: march });

		const { buckets } = await read();

		await expectMainGrouping(TIME_ZONES, buckets);
		useTimeZone("America/New_York");
		expect(groupPublishedDateBuckets([{ bucket: "2026-01-01T00:30:00Z", count: 1 }])).toEqual([
			{ label: "December 2025", count: 1, url: "/archives/2025/12" },
		]);
	});

	it("returns a bounded number of buckets for 50,000 posts over ten years", async () => {
		const start = Date.UTC(2016, 0, 1);
		const span = Date.UTC(2026, 0, 1) - start;
		const posts = 50_000;
		await seedMany(
			Array.from({ length: posts }, (_, index) =>
				new Date(start + Math.floor((span * index) / posts)).toISOString(),
			),
		);

		const { buckets } = await read();

		expect(buckets.length).toBeLessThan(10_000);
		expect(buckets.reduce((total, { count }) => total + count, 0)).toBe(posts);
		await expectMainGrouping(["America/New_York", "Asia/Kathmandu", "Pacific/Kiritimati"], buckets);
	});

	it("ignores missing and malformed publication dates and omits validators through L2", async () => {
		await seed("valid", march);
		await seed("missing-date", null, { updatedAt: may });
		await seed("empty-date", "");
		await seed("invalid-date", "not-a-date");
		await seed("invalid-update", april, { updatedAt: "not-a-date" });
		await enableCache();
		const first = await read();
		await waitForDeferredTasks();
		const second = await read();
		expect(first.error).toBeUndefined();
		expect(second).toEqual(first);
		expect(groupPublishedDateBuckets(second.buckets)).toEqual([
			{ label: "April 2026", count: 1, url: "/archives/2026/04" },
			{ label: "March 2026", count: 1, url: "/archives/2026/03" },
		]);
		expect(second.cacheHint.lastModified).toBeUndefined();
		expect(contentReads()).toHaveLength(1);
	});

	it("does not reuse a publication dates or months cache record", async () => {
		await seed("published", march);
		await enableCache();
		await cachedQuery({
			namespace: contentCacheNamespaces("post"),
			key: `publishedDates:v2:${JSON.stringify(["post", undefined])}`,
			load: async () => ({
				dates: [new Date("2020-01-01T00:00:00.000Z")],
				cacheHint: { tags: ["post"] },
			}),
		});
		await cachedQuery({
			namespace: contentCacheNamespaces("post"),
			key: `publishedMonths:${JSON.stringify(["post", undefined])}`,
			load: async () => ({
				months: [{ month: "2020-01", count: 1 }],
				cacheHint: { tags: ["post"] },
			}),
		});

		await waitForDeferredTasks();
		const result = await read();

		expect(result.buckets).toEqual([{ bucket: "2026-03-15", count: 1 }]);
	});

	it("resolves explicit, request and configured locales without mixing cached months", async () => {
		await seed("english", march, { locale: "en" });
		await seed("french", april, { locale: "fr" });
		setI18nConfig({ defaultLocale: "fr", locales: ["en", "fr"] });
		await enableCache();
		expect(bucketKeys((await read({ locale: "en" }, { locale: "fr" })).buckets)).toEqual([
			"2026-03-15",
		]);
		expect(bucketKeys((await read(undefined, { locale: "en" })).buckets)).toEqual(["2026-03-15"]);
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-04-15"]);
		await waitForDeferredTasks();
		setI18nConfig(null);
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-04-15", "2026-03-15"]);
		expect(bucketKeys((await read({ locale: "fr" })).buckets)).toEqual(["2026-04-15"]);
		await waitForDeferredTasks();
		const before = contentReads().length;
		expect(bucketKeys((await read({ locale: "fr" })).buckets)).toEqual(["2026-04-15"]);
		expect(contentReads()).toHaveLength(before);
	});

	it("preserves collection results when content localization is disabled", async () => {
		await seed("english", march, { locale: "en" });
		await seed("french", april, { locale: "fr" });
		for (const config of [null, { defaultLocale: "fr", locales: ["fr"] }]) {
			setI18nConfig(config);
			const expected = await runWithContext({ editMode: false, db }, () =>
				getEmDashCollection<string, { publishedAt: Date }>("post", {
					orderBy: { published_at: "desc" },
				}),
			);
			expect(groupPublishedDateBuckets((await read()).buckets, { limit: 100 })).toEqual(
				groupLikeMain(
					expected.entries.map((entry) => entry.data.publishedAt),
					{ limit: 100 },
				),
			);
		}
	});

	it("shares concurrent reads within one request without reusing them in the next request", async () => {
		await seed("published", march);
		await runWithContext({ editMode: false, db }, async () => {
			const results = await Promise.all([
				getPublishedDateBuckets("post"),
				getPublishedDateBuckets("post"),
			]);
			expect(results[0]).toEqual(results[1]);
			expect(contentReads()).toHaveLength(1);
		});
		await read();
		expect(contentReads()).toHaveLength(2);
	});

	it("rejects invalid collection identifiers and binds locale values", async () => {
		await seed("published", march);
		const invalid = await runWithContext({ editMode: false, db }, () =>
			getPublishedDateBuckets("post; DROP TABLE ec_post"),
		);
		expect(invalid.error).toBeInstanceOf(Error);
		expect(invalid.buckets).toEqual([]);
		expect(queries).toHaveLength(0);
		expect((await read({ locale: "en' OR 1=1 --" })).buckets).toEqual([]);
		expect(bucketKeys((await read({ locale: "en" })).buckets)).toEqual(["2026-03-15"]);
	});

	it("reloads cached months only after current collection invalidation", async () => {
		const id = await seed("published", march);
		await enableCache();
		await read();
		await waitForDeferredTasks();
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-03-15"]);
		expect(contentReads()).toHaveLength(1);
		await sql`UPDATE ec_post SET published_at = ${april} WHERE id = ${id}`.execute(ctx.db);
		invalidateCollectionCache("post");
		await waitForDeferredTasks();
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-04-15"]);
		await waitForDeferredTasks();
		await sql`UPDATE ec_post SET published_at = ${may} WHERE id = ${id}`.execute(ctx.db);
		invalidateObjectCache("content:post");
		await waitForDeferredTasks();
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-04-15"]);
		expect(contentReads()).toHaveLength(2);
		invalidateObjectCache("content:v2:post");
		await waitForDeferredTasks();
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-05-15"]);
		expect(contentReads()).toHaveLength(3);
	});

	it.each(["edit", "preview", "isolated"])(
		"bypasses L2 reads and writes for %s requests",
		async (mode) => {
			const id = await seed("published", march);
			await seed("draft", may, { status: "draft" });
			await enableCache();
			await read();
			await waitForDeferredTasks();
			await sql`UPDATE ec_post SET published_at = ${april} WHERE id = ${id}`.execute(ctx.db);
			const context: Partial<EmDashRequestContext> =
				mode === "edit"
					? { editMode: true }
					: mode === "preview"
						? { preview: { collection: "post", id } }
						: { dbIsIsolated: true };
			expect(bucketKeys((await read(undefined, context)).buckets)).toEqual(["2026-04-15"]);
			await waitForDeferredTasks();
			expect(bucketKeys((await read(undefined, context)).buckets)).toEqual(["2026-04-15"]);
			await waitForDeferredTasks();
			expect(bucketKeys((await read()).buckets)).toEqual(["2026-03-15"]);
			expect(contentReads()).toHaveLength(3);
		},
	);

	it("retries a failed read within the request without retaining its error in either cache", async () => {
		await seed("published", march);
		await enableCache();
		failNextRead = true;
		await runWithContext({ editMode: false, db }, async () => {
			const failed = await getPublishedDateBuckets("post");
			expect(failed.error).toBeInstanceOf(Error);
			expect(failed.buckets).toEqual([]);
			await waitForDeferredTasks();
			const retried = await getPublishedDateBuckets("post");
			expect(retried.error).toBeUndefined();
			expect(bucketKeys(retried.buckets)).toEqual(["2026-03-15"]);
		});
		await waitForDeferredTasks();
		expect(bucketKeys((await read()).buckets)).toEqual(["2026-03-15"]);
		expect(contentReads()).toHaveLength(2);
	});

	it("does not cache a missing table as an empty collection", async () => {
		await enableCache();
		const load = () =>
			runWithContext({ editMode: false, db }, () => getPublishedDateBuckets("missing"));
		const missing = await load();
		expect(missing.buckets).toEqual([]);
		expect(missing.error).toBeUndefined();
		await waitForDeferredTasks();
		await sql`CREATE TABLE ec_missing (
			id TEXT PRIMARY KEY, published_at TEXT, updated_at TEXT,
			status TEXT, deleted_at TEXT, locale TEXT
		)`.execute(ctx.db);
		await sql`INSERT INTO ec_missing VALUES ('entry', ${march}, ${march}, 'published', NULL, 'en')`.execute(
			ctx.db,
		);
		expect(bucketKeys((await load()).buckets)).toEqual(["2026-03-15"]);
	});
});
