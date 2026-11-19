import { type Kysely, sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleSitemapData, handleSitemapIndexData } from "../../../src/api/handlers/seo.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

/** The sitemap queries as they were before they were rewritten for Postgres. */
function referenceRows() {
	return sql`
		FROM ec_post c
		LEFT JOIN _emdash_seo s ON s.collection = 'post' AND s.content_id = c.id
		WHERE c.status = 'published'
		AND c.deleted_at IS NULL
		AND c.slug IS NOT NULL
		AND TRIM(c.slug) <> ''
		AND (s.seo_no_index IS NULL OR s.seo_no_index = 0)
	`;
}

async function referenceIndex(db: Kysely<Database>, pageSize: number) {
	const { rows } = await sql<{ page: number | string; lastmod: string }>`
		SELECT p.page AS page, MAX(p.updated_at) AS lastmod
		FROM (
			SELECT c.updated_at, (ROW_NUMBER() OVER (ORDER BY c.id) - 1) / CAST(${pageSize} AS INTEGER) AS page
			${referenceRows()}
		) p
		GROUP BY p.page
		ORDER BY p.page
	`.execute(db);
	return rows.map((row) => ({ page: Number(row.page) + 1, lastmod: row.lastmod }));
}

async function referencePage(db: Kysely<Database>, page: number, pageSize: number) {
	const { rows } = await sql<{ id: string; on_page: number | string; seo_image: string | null }>`
		WITH page AS (
			SELECT c.id, c.translation_group ${referenceRows()}
			ORDER BY c.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
		)
		SELECT c.id, s.seo_image, CASE WHEN c.id IN (SELECT id FROM page) THEN 1 ELSE 0 END AS on_page
		${referenceRows()}
		AND (c.id IN (SELECT id FROM page) OR c.translation_group IN (SELECT translation_group FROM page))
		ORDER BY c.id
	`.execute(db);
	return {
		entries: rows.filter((row) => Number(row.on_page) === 1).map((row) => [row.id, row.seo_image]),
		translations: rows
			.filter((row) => Number(row.on_page) === 0)
			.map((row) => [row.id, row.seo_image]),
	};
}

describeEachDialect("sitemap queries", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();

		const repo = new ContentRepository(ctx.db);
		const ids: string[] = [];
		for (let i = 0; i < 60; i++) {
			const source = i % 4 === 1 ? ids[i - 1] : undefined;
			const item = await repo.create({
				type: "post",
				slug: `entry-${i % 4 === 1 ? i - 1 : i}`,
				data: {},
				status: i % 9 === 4 ? "draft" : "published",
				locale: source ? "fr" : "en",
				translationOf: source,
			});
			ids.push(item.id);
		}

		for (const [i, id] of ids.entries()) {
			const day = String(1 + ((i * 7) % 28)).padStart(2, "0");
			await sql`UPDATE ec_post SET updated_at = ${`2025-03-${day} 10:00:00`} WHERE id = ${id}`.execute(
				ctx.db,
			);
			if (i % 11 === 3) {
				await sql`UPDATE ec_post SET deleted_at = '2025-04-01 00:00:00' WHERE id = ${id}`.execute(
					ctx.db,
				);
			}
			if (i % 13 === 6) {
				await sql`UPDATE ec_post SET slug = ${" ".repeat(i)} WHERE id = ${id}`.execute(ctx.db);
			}
			if (i % 5 === 2) {
				await sql`
					INSERT INTO _emdash_seo (collection, content_id, seo_image, seo_no_index)
					VALUES ('post', ${id}, ${i % 2 === 0 ? `media-${i}` : null}, ${i % 3 === 0 ? 1 : 0})
				`.execute(ctx.db);
			}
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	for (const pageSize of [1, 7, 2000]) {
		it(`list the same pages and entries as before at ${pageSize} per page`, async () => {
			const index = await handleSitemapIndexData(ctx.db, pageSize);
			const expectedIndex = await referenceIndex(ctx.db, pageSize);
			expect(index.data?.sitemaps.map(({ page, lastmod }) => ({ page, lastmod }))).toEqual(
				expectedIndex.map(({ page, lastmod }) => ({
					page,
					lastmod: new Date(`${lastmod.replace(" ", "T")}Z`).toISOString(),
				})),
			);
			expect(expectedIndex.length).toBeGreaterThan(0);

			for (let page = 1; page <= expectedIndex.length + 1; page++) {
				const expected = await referencePage(ctx.db, page, pageSize);
				for (const includeTranslations of [true, false]) {
					const result = await handleSitemapData(ctx.db, "post", {
						page,
						pageSize,
						includeTranslations,
					});
					const col = result.data?.collections[0];
					expect(col?.entries.map((e) => [e.id, e.image]) ?? []).toEqual(expected.entries);
					expect(col?.translations.map((e) => [e.id, e.image]) ?? []).toEqual(
						includeTranslations || !col ? expected.translations : [],
					);
				}
			}
		});
	}
});
