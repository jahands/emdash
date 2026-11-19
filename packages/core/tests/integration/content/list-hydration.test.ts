import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { resetBylineFieldDefsCacheForTests } from "../../../src/bylines/field-defs-cache.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { runWithContext } from "../../../src/request-context.js";
import { BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function ok<T>(
	result: { success: true; data: T } | { success: false; error: { message: string } },
): T {
	if (!result.success) throw new Error(result.error.message);
	return result.data;
}

// A list reads SEO, bylines and pending drafts with its rows; the single-entry
// read loads each separately, so the two must agree entry by entry.
describeEachDialect("content list hydration", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		resetBylineFieldDefsCacheForTests();
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			supports: ["drafts", "revisions", "seo"],
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "due", label: "Due", type: "datetime" });
		await new BylineSchemaRegistry(db).createField({
			slug: "job_title",
			label: "Job title",
			type: "string",
			translatable: true,
		});
		for (const id of ["user_linked", "user_plain"]) {
			await db
				.insertInto("users")
				.values({ id, email: `${id}@example.com`, name: id, role: 40, email_verified: 1 })
				.execute();
		}
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("matches the single-entry read for SEO, bylines and pending drafts", async () => {
		const bylines = new BylineRepository(db);
		const words = await bylines.create({
			slug: "words",
			displayName: "Words",
			customFields: { job_title: "Writer" },
		});
		const photos = await bylines.create({ slug: "photos", displayName: "Photos" });
		const linked = await bylines.create({
			slug: "linked",
			displayName: "Linked",
			userId: "user_linked",
			customFields: { job_title: "Owner" },
		});

		const credited = ok(
			await runtime.handleContentCreate("posts", {
				data: { title: "Credited" },
				slug: "credited",
				bylines: [
					{ bylineId: photos.id, roleLabel: "Photos" },
					{ bylineId: words.id, roleLabel: "Words" },
				],
				seo: { title: "Credited SEO", noIndex: true },
			}),
		).item;
		ok(await runtime.handleContentPublish("posts", credited.id));
		ok(
			await runtime.handleContentCreate("posts", {
				data: { title: "Inferred" },
				slug: "inferred",
				authorId: "user_linked",
			}),
		);
		ok(
			await runtime.handleContentCreate("posts", {
				data: { title: "Uncredited" },
				slug: "uncredited",
				authorId: "user_plain",
			}),
		);
		const drafted = ok(
			await runtime.handleContentCreate("posts", {
				data: { title: "Saved title", due: "2026-01-02T03:04:05.000Z" },
				slug: "drafted",
				authorId: "user_linked",
			}),
		).item;
		ok(
			await runtime.handleContentUpdate("posts", drafted.id, {
				data: { title: "Pending title", due: "2026-02-03T04:05:06.000Z" },
			}),
		);

		const list = await runWithContext({ editMode: false }, async () =>
			ok(await runtime.handleContentList("posts", { limit: 50 })),
		);
		expect(
			list.items.map((item) => item.slug ?? "").toSorted((a, b) => a.localeCompare(b)),
		).toEqual(["credited", "drafted", "inferred", "uncredited"]);

		for (const listed of list.items) {
			const { item } = await runWithContext({ editMode: false }, async () =>
				ok(await runtime.handleContentGet("posts", listed.id)),
			);
			expect(listed.seo, listed.slug ?? "").toEqual(item.seo);
			expect(listed.bylines, listed.slug ?? "").toEqual(item.bylines);
			expect(listed.byline, listed.slug ?? "").toEqual(item.byline);
			expect(listed.data, listed.slug ?? "").toEqual(item.data);
		}

		const bySlug = new Map(list.items.map((item) => [item.slug, item]));
		expect(bySlug.get("credited")?.seo).toEqual(
			expect.objectContaining({ title: "Credited SEO", noIndex: true }),
		);
		expect(
			bySlug.get("credited")?.bylines?.map((credit) => [credit.byline.slug, credit.roleLabel]),
		).toEqual([
			["photos", "Photos"],
			["words", "Words"],
		]);
		expect(bySlug.get("credited")?.bylines?.[1]?.byline.customFields).toEqual({
			job_title: "Writer",
		});
		expect(bySlug.get("inferred")?.bylines).toEqual([
			expect.objectContaining({
				source: "inferred",
				byline: expect.objectContaining({ id: linked.id, customFields: { job_title: "Owner" } }),
			}),
		]);
		expect(bySlug.get("uncredited")?.bylines).toEqual([]);
		expect(bySlug.get("uncredited")?.byline).toBeNull();
		expect(bySlug.get("drafted")?.data).toEqual(
			expect.objectContaining({ title: "Pending title", due: "2026-02-03T04:05:06.000Z" }),
		);
	});
});
