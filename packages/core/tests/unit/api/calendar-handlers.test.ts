import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	CALENDAR_RANGE_LIMIT,
	handleCalendarEntries,
	handleCalendarRange,
	type CalendarEntry,
} from "../../../src/api/handlers/calendar.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { encodeCursor } from "../../../src/database/repositories/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const BEFORE_FIXTURES = new Date("2029-01-01T00:00:00.000Z");
const MARCH = { from: "2030-03-01T00:00:00.000Z", to: "2030-04-01T00:00:00.000Z" };

describeEachDialect("calendar handler", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function published(type: string, title: string, publishedAt: string) {
		return repo.create({
			type,
			slug: title.toLowerCase().replaceAll(" ", "-"),
			data: { title },
			status: "published",
			publishedAt,
		});
	}

	async function scheduled(type: string, title: string, scheduledAt: string) {
		const item = await repo.create({
			type,
			slug: title.toLowerCase().replaceAll(" ", "-"),
			data: { title },
		});
		return repo.schedule(type, item.id, scheduledAt, BEFORE_FIXTURES);
	}

	async function entries(bounds = MARCH, limit = 100): Promise<CalendarEntry[]> {
		const result = await handleCalendarEntries(ctx.db, { ...bounds, limit });
		if (!result.success) throw new Error(`calendar failed: ${result.error.code}`);
		return result.data.items;
	}

	it("places published entries, schedules, and scheduled updates", async () => {
		const pricing = await published("post", "Pricing", "2030-03-02T09:00:00.000Z");
		await repo.schedule("post", pricing.id, "2030-03-10T12:00:00.000Z", BEFORE_FIXTURES);
		await published("post", "Launch", "2030-03-05T10:00:00.000Z");
		await published("page", "About", "2030-03-05T10:00:00.000Z");
		await scheduled("post", "Roadmap", "2030-03-08T08:00:00.000Z");

		await repo.create({ type: "post", slug: "idea", data: { title: "Idea" } });
		const trashed = await published("post", "Trashed", "2030-03-06T10:00:00.000Z");
		await repo.delete("post", trashed.id);
		const retired = await published("post", "Retired", "2030-03-04T10:00:00.000Z");
		await repo.unpublish("post", retired.id);
		await published("post", "Old news", "2030-02-27T10:00:00.000Z");
		await scheduled("post", "Far future", "2030-05-01T10:00:00.000Z");

		const result = await entries();

		expect(result.map((e) => [e.collection, e.title, e.kind, e.status, e.at])).toEqual([
			["post", "Pricing", "published", "published", "2030-03-02T09:00:00.000Z"],
			["page", "About", "published", "published", "2030-03-05T10:00:00.000Z"],
			["post", "Launch", "published", "published", "2030-03-05T10:00:00.000Z"],
			["post", "Roadmap", "scheduled", "scheduled", "2030-03-08T08:00:00.000Z"],
			["post", "Pricing", "scheduled", "published", "2030-03-10T12:00:00.000Z"],
		]);
		expect(result[0]).toEqual({
			collection: "post",
			id: pricing.id,
			locale: "en",
			title: "Pricing",
			status: "published",
			kind: "published",
			at: "2030-03-02T09:00:00.000Z",
		});
	});

	it("walks every event exactly once across pages", async () => {
		const tie = "2030-03-03T10:00:00.000Z";
		const later = "2030-03-04T10:00:00.000Z";
		await published("post", "Alpha", tie);
		await published("post", "Bravo", tie);
		await published("page", "Charlie", tie);
		await scheduled("post", "Delta", tie);
		await scheduled("page", "Echo", later);
		await published("post", "Foxtrot", later);
		await published("post", "Golf", later);

		const all = await entries();
		expect(all).toHaveLength(7);
		const exact = await handleCalendarEntries(ctx.db, { ...MARCH, limit: 7 });
		if (!exact.success) throw new Error(`calendar failed: ${exact.error.code}`);
		expect(exact.data.nextCursor).toBeUndefined();

		const walked: CalendarEntry[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 10; page++) {
			// oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
			const result = await handleCalendarEntries(ctx.db, { ...MARCH, limit: 2, cursor });
			if (!result.success) throw new Error(`calendar failed: ${result.error.code}`);
			walked.push(...result.data.items);
			cursor = result.data.nextCursor;
			if (!cursor) break;
		}

		expect(walked).toEqual(all);
	});

	async function walk(bounds = MARCH, limit = 2): Promise<CalendarEntry[]> {
		const walked: CalendarEntry[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page++) {
			// oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
			const result = await handleCalendarEntries(ctx.db, { ...bounds, limit, cursor });
			if (!result.success) throw new Error(`calendar failed: ${result.error.code}`);
			walked.push(...result.data.items);
			cursor = result.data.nextCursor;
			if (!cursor) return walked;
		}
		throw new Error("calendar walk did not end");
	}

	async function range(bounds = MARCH) {
		const result = await handleCalendarRange(ctx.db, bounds);
		if (!result.success) throw new Error(`calendar range failed: ${result.error.code}`);
		return result.data;
	}

	/** Writes published `post` rows directly; the repository is too slow for the entry cap. */
	async function insertPublished(rows: { id: string; at: string; deleted?: boolean }[]) {
		for (let start = 0; start < rows.length; start += 200) {
			const values = rows
				.slice(start, start + 200)
				.map(
					(row) =>
						sql`(${row.id}, ${row.id}, 'published', ${row.id}, ${row.at}, ${row.deleted ? row.at : null})`,
				);
			// oxlint-disable-next-line no-await-in-loop -- inserts run one batch at a time
			await sql`
				INSERT INTO ec_post (id, slug, status, title, published_at, deleted_at)
				VALUES ${sql.join(values)}
			`.execute(ctx.db);
		}
	}

	it("returns the whole range in the order the pages walk it", async () => {
		const tie = "2030-03-03T10:00:00.000Z";
		const alpha = await published("post", "Alpha", tie);
		const bravo = await published("post", "Bravo", tie);
		await published("page", "Charlie", tie);
		await scheduled("post", "Delta", tie);
		await scheduled("page", "Echo", "2030-03-04T10:00:00.000Z");
		await published("post", "Foxtrot", MARCH.from);
		await published("post", "Too late", MARCH.to);
		const tiedPosts = [alpha, bravo].toSorted((a, b) => (a.id < b.id ? -1 : 1));

		const result = await range();

		expect(result.truncated).toBe(false);
		expect(result.items.map((e) => e.title)).toEqual([
			"Foxtrot",
			"Charlie",
			...tiedPosts.map((item) => item.data.title),
			"Delta",
			"Echo",
		]);
		expect(result.items).toEqual(await walk());
	});

	it("stops at the entry cap with the earliest entries and reports the cut", async () => {
		const day = Date.parse("2030-03-02T00:00:00.000Z");
		const rows = Array.from({ length: CALENDAR_RANGE_LIMIT + 1 }, (_, index) => ({
			id: `e${String(index).padStart(5, "0")}`,
			at: new Date(day + index * 60_000).toISOString(),
		}));
		await insertPublished(rows);

		const cut = await range();

		expect(cut.truncated).toBe(true);
		expect(cut.items.map((e) => e.id)).toEqual(
			rows.slice(0, CALENDAR_RANGE_LIMIT).map((row) => row.id),
		);

		await sql`DELETE FROM ec_post WHERE id = ${rows.at(-1)!.id}`.execute(ctx.db);
		const exact = await range();

		expect(exact.truncated).toBe(false);
		expect(exact.items).toHaveLength(CALENDAR_RANGE_LIMIT);
	});

	it("leaves trashed entries out of the range and the entry cap", async () => {
		const day = Date.parse("2030-03-02T00:00:00.000Z");
		await insertPublished(
			Array.from({ length: CALENDAR_RANGE_LIMIT + 1 }, (_, index) => ({
				id: `t${String(index).padStart(5, "0")}`,
				at: new Date(day + index * 60_000).toISOString(),
				deleted: true,
			})),
		);
		await published("post", "Kept", "2030-03-20T10:00:00.000Z");
		const trashedSchedule = await scheduled("page", "Trashed schedule", "2030-03-21T10:00:00.000Z");
		await repo.delete("page", trashedSchedule.id);

		const result = await range();

		expect(result).toMatchObject({ truncated: false, items: [{ title: "Kept" }] });
		expect(result.items).toHaveLength(1);
	});

	it("lists each locale's entry with its locale", async () => {
		const english = await published("post", "Launch", "2030-03-05T10:00:00.000Z");
		const french = await repo.create({
			type: "post",
			slug: "launch",
			data: { title: "Lancement" },
			status: "published",
			publishedAt: "2030-03-06T10:00:00.000Z",
			locale: "fr",
			translationOf: english.id,
		});

		const result = await range();

		expect(result.items.map((e) => [e.id, e.locale, e.title])).toEqual([
			[english.id, "en", "Launch"],
			[french.id, "fr", "Lancement"],
		]);
	});

	it("merges many collections in time order", async () => {
		const registry = new SchemaRegistry(ctx.db);
		const slugs = Array.from({ length: 9 }, (_, index) => `extra_${index}`);
		for (const slug of slugs) {
			// oxlint-disable-next-line no-await-in-loop -- schema changes run one at a time
			await registry.createCollection({ slug, label: slug, labelSingular: slug });
			// oxlint-disable-next-line no-await-in-loop -- schema changes run one at a time
			await registry.createField(slug, { slug: "title", label: "Title", type: "string" });
		}
		const expected: string[] = [];
		for (const [index, slug] of slugs.toReversed().entries()) {
			const day = `2030-03-${String(index + 2).padStart(2, "0")}`;
			// oxlint-disable-next-line no-await-in-loop -- entries are created in order
			await scheduled(slug, `Scheduled ${slug}`, `${day}T09:00:00.000Z`);
			// oxlint-disable-next-line no-await-in-loop -- entries are created in order
			await published(slug, `Published ${slug}`, `${day}T10:00:00.000Z`);
			expected.push(`Scheduled ${slug}`, `Published ${slug}`);
		}

		const result = await range();

		expect(result.items.map((e) => e.title)).toEqual(expected);
		expect(result.items).toEqual(await walk(MARCH, 3));
	});

	it("uses the collection's title field, then title, then slug", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "headline", label: "Headline", type: "string" });
		await registry.updateCollection("post", { titleField: "headline" });
		const at = "2030-03-05T10:00:00.000Z";
		await repo.create({
			type: "post",
			slug: "with-headline",
			data: { title: "Title", headline: "Headline" },
			status: "published",
			publishedAt: at,
		});
		await repo.create({
			type: "post",
			slug: "empty-headline",
			data: { title: "Fallback title", headline: "" },
			status: "published",
			publishedAt: "2030-03-06T10:00:00.000Z",
		});
		await repo.create({
			type: "post",
			slug: "only-slug",
			data: { title: "" },
			status: "published",
			publishedAt: "2030-03-07T10:00:00.000Z",
		});
		await published("page", "Contact", at);
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ title_field: "missing" })
			.where("slug", "=", "page")
			.execute();

		const result = await entries();

		expect(result.map((e) => e.title)).toEqual([
			"Contact",
			"Headline",
			"Fallback title",
			"only-slug",
		]);
	});

	it("leaves out hidden collections", async () => {
		await published("post", "Visible", "2030-03-05T10:00:00.000Z");
		await published("page", "Hidden", "2030-03-06T10:00:00.000Z");
		await new SchemaRegistry(ctx.db).updateCollection("page", { hidden: true });

		const result = await entries();

		expect(result.map((e) => e.title)).toEqual(["Visible"]);
	});

	it("rejects malformed cursors", async () => {
		const cursors = [
			"not-a-cursor",
			encodeCursor("2030-03-03T10:00:00.000Z", "id"),
			encodeCursor("2030-03-03T10:00:00.000Z|post|draft", "id"),
			encodeCursor("2030-03-03T10:00:00.000Z|Posts!|published", "id"),
			encodeCursor("2030-03-03T10:00:00.000Z|post|published", ""),
			encodeCursor("zzzz|post|published", "id"),
			encodeCursor("2030-03-03T10:00:00Z|post|published", "id"),
		];

		for (const cursor of cursors) {
			// oxlint-disable-next-line no-await-in-loop -- one assertion per cursor
			const result = await handleCalendarEntries(ctx.db, { ...MARCH, limit: 10, cursor });
			expect(result).toMatchObject({ success: false, error: { code: "INVALID_CURSOR" } });
		}
	});
});
