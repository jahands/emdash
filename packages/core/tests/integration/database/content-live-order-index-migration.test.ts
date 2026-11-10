import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration096 from "../../../src/database/migrations/096_content_live_order_indexes.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

const LOCALES = ["en", "fr", "ja"];

function isLiveOrderIndex(name: string): boolean {
	return name.endsWith("_live_pub") || name.endsWith("_live_crt");
}

describeEachDialect("live order index migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "article", label: "A", labelSingular: "A" });
		await registry.createField("article", { slug: "title", label: "T", type: "string" });
		const repo = new ContentRepository(ctx.db);
		for (let i = 0; i < 30; i++) {
			await repo.create({
				type: "article",
				slug: `entry-${i}`,
				status: i % 7 === 0 ? "draft" : "published",
				publishedAt: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
				locale: LOCALES[i % LOCALES.length],
				data: { title: `Entry ${i}` },
			});
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function liveOrderIndexes(tableName: string): Promise<string[]> {
		if (dialect === "postgres") {
			const result = await sql<{ indexname: string }>`
				SELECT indexname FROM pg_indexes
				WHERE tablename = ${tableName} AND schemaname = current_schema()
			`.execute(ctx.db);
			return result.rows.map((row) => row.indexname).filter(isLiveOrderIndex);
		}
		const result = await sql<{ name: string }>`
			SELECT name FROM sqlite_master
			WHERE type = 'index' AND tbl_name = ${tableName}
		`.execute(ctx.db);
		return result.rows.map((row) => row.name).filter(isLiveOrderIndex);
	}

	const expectedIndexes = ["idx_ec_article_live_crt", "idx_ec_article_live_pub"];

	it("adds the indexes to existing tables on PostgreSQL only, and can restart", async () => {
		if (dialect === "postgres") {
			await migration096.down(ctx.db);
			await expect(liveOrderIndexes("ec_article")).resolves.toEqual([]);
			await migration096.up(ctx.db);
			await migration096.up(ctx.db);
			expect((await liveOrderIndexes("ec_article")).toSorted()).toEqual(expectedIndexes);
		} else {
			await migration096.up(ctx.db);
			await expect(liveOrderIndexes("ec_article")).resolves.toEqual([]);
		}
	});

	it("gives new collections the same indexes", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "product", label: "P", labelSingular: "P" });

		const names = await liveOrderIndexes("ec_product");
		expect(names.toSorted()).toEqual(
			dialect === "postgres" ? ["idx_ec_product_live_crt", "idx_ec_product_live_pub"] : [],
		);
	});

	it.runIf(dialect === "postgres")("serves published listings from the partial index", async () => {
		await sql`
			INSERT INTO ec_article (id, slug, status, locale, translation_group, created_at, updated_at, published_at, version, title)
			SELECT 'bulk-' || g, 'bulk-' || g,
				CASE WHEN g % 20 = 0 THEN 'draft' ELSE 'published' END,
				(ARRAY['en','fr','ja'])[1 + g % 3], 'group-' || g,
				'2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
				to_char(timestamp '2020-01-01' + g * interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 1, 't'
			FROM generate_series(1, 20000) g
		`.execute(ctx.db);
		await sql`ANALYZE ec_article`.execute(ctx.db);
		const cursor = "2021-06-01T00:00:00.000Z";

		const plans = await Promise.all(
			[
				sql`deleted_at IS NULL AND status = 'published' ORDER BY published_at DESC, id DESC`,
				sql`deleted_at IS NULL AND status = 'published' AND locale = 'fr' ORDER BY published_at DESC, id DESC`,
				sql`deleted_at IS NULL AND status = 'published' AND (published_at < ${cursor} OR (published_at = ${cursor} AND id < 'zzz')) ORDER BY published_at DESC, id DESC`,
			].map((condition) =>
				sql<{
					"QUERY PLAN": string;
				}>`EXPLAIN SELECT * FROM ec_article WHERE ${condition} LIMIT 11`.execute(ctx.db),
			),
		);

		for (const plan of plans) {
			const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
			expect(text).toContain("idx_ec_article_live_pub");
			expect(text).not.toContain("Sort");
		}
	});
});
