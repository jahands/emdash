/**
 * Query-plan coverage for content lists ordered by a timestamp.
 *
 * Postgres can't order by the `deleted_at`-led composites because it doesn't
 * treat `deleted_at IS NULL` as an equality, so it relies on the partial
 * `live_*` indexes from migration 098. SQLite can, so it gets none. SQLite runs
 * without sqlite_stat1 here, matching D1's stats-blind planner.
 */

import { CompiledQuery, Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeEach, expect, it } from "vitest";

import * as migration098 from "../../../src/database/migrations/098_content_live_list_indexes.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	destroySharedPool,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

const ROWS = 3000;
const LIVE_INDEXES = ["idx_ec_post_live_crt", "idx_ec_post_live_pub", "idx_ec_post_live_upd"];

const LATEST_PUBLISHED = sql`
	SELECT id FROM ec_post
	WHERE deleted_at IS NULL AND status = ${"published"}
	ORDER BY published_at DESC, id DESC LIMIT 12
`;
const RECENTLY_UPDATED = sql`
	SELECT id FROM ec_post WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 10
`;

afterAll(destroySharedPool);

describeEachDialect("content live list indexes", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let captured: CompiledQuery[];

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		captured = [];
		db = ctx.db.withPlugin({
			transformQuery(args) {
				const compiled = ctx.db.getExecutor().compileQuery(args.node, args.queryId);
				if (compiled.sql.includes("ec_post")) captured.push(compiled);
				return args.node;
			},
			transformResult: async (args) => args.result,
		});
		await new SchemaRegistry(ctx.db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await seedRows();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("reads admin and public lists in index order", async () => {
		for (const query of await listQueries()) {
			await expectOrderedByIndex(query);
		}
	});

	it("starts a later admin page at its cursor instead of filtering from the first row", async () => {
		const repo = new ContentRepository(db);
		const first = await repo.findMany("post", { limit: 20 });
		captured = [];
		const second = await repo.findMany("post", { limit: 20, cursor: first.nextCursor });
		const plan = await planOf(pageQuery());

		expect(second.items[0]?.id < first.items.at(-1)!.id).toBe(true);
		if (dialect === "postgres") {
			expect(plan).toMatch(/Index Cond: \(ROW\(created_at, id\) </);
		} else {
			expect(plan).toMatch(
				/INDEX idx_ec_post_deleted_created_id \(deleted_at=\? AND \(created_at,id\)<\(\?,\?\)\)/,
			);
		}
	});

	it("adds the list indexes to existing tables without changing results", async () => {
		await dropLiveIndexes();
		const before = await new ContentRepository(ctx.db).findMany("post", { limit: 20 });
		if (dialect === "postgres") {
			expect(await planOf(await adminListQuery())).toContain("Sort");
		}

		await migration098.up(ctx.db);

		expect(await liveIndexes()).toEqual(dialect === "postgres" ? LIVE_INDEXES : []);
		const after = await new ContentRepository(ctx.db).findMany("post", { limit: 20 });
		expect(after.items.map((item) => item.id)).toEqual(before.items.map((item) => item.id));
		for (const query of await listQueries()) {
			await expectOrderedByIndex(query);
		}
	});

	it("finishes a run that stopped after some of the indexes", async () => {
		await sql`DROP INDEX IF EXISTS ${sql.ref("idx_ec_post_live_upd")}`.execute(ctx.db);
		await sql`DROP INDEX IF EXISTS ${sql.ref("idx_ec_post_live_pub")}`.execute(ctx.db);

		await migration098.up(ctx.db);
		await migration098.up(ctx.db);

		expect(await liveIndexes()).toEqual(dialect === "postgres" ? LIVE_INDEXES : []);
	});

	it("removes the indexes on rollback", async () => {
		await migration098.down(ctx.db);
		expect(await liveIndexes()).toEqual([]);
	});

	if (dialect === "postgres") {
		it("rebuilds an index that an interrupted concurrent build left invalid", async () => {
			await sql`DROP INDEX ${sql.ref("idx_ec_post_live_crt")}`.execute(ctx.db);
			await expect(
				sql`CREATE UNIQUE INDEX CONCURRENTLY ${sql.ref("idx_ec_post_live_crt")} ON ec_post (status)`.execute(
					ctx.db,
				),
			).rejects.toThrow();
			expect(await invalidIndexes()).toEqual(["idx_ec_post_live_crt"]);

			await migration098.up(ctx.db);

			expect(await invalidIndexes()).toEqual([]);
			await expectOrderedByIndex(await adminListQuery());
		});

		it("keeps the index names distinct for the longest collection slug", async () => {
			const slug = `t${"o".repeat(45)}`;
			await new SchemaRegistry(ctx.db).createCollection({
				slug,
				label: "Long",
				labelSingular: "Long",
			});
			const result = await sql<{ indexdef: string }>`
				SELECT indexdef FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ${`ec_${slug}`}
				AND indexdef LIKE '%WHERE (deleted_at IS NULL)'
			`.execute(ctx.db);
			const definitions = result.rows.map((row) => row.indexdef.replace(/^.* USING btree /, ""));
			expect(definitions.toSorted()).toEqual([
				"(created_at DESC, id DESC) WHERE (deleted_at IS NULL)",
				"(status, published_at DESC, id DESC) WHERE (deleted_at IS NULL)",
				"(updated_at DESC, id DESC) WHERE (deleted_at IS NULL)",
			]);
		});
	}

	async function seedRows(): Promise<void> {
		const rows = Array.from({ length: ROWS }, (_, index) => {
			const at = new Date(Date.UTC(2020, 0, 1) + index * 3_600_000).toISOString();
			const draft = index % 50 === 0;
			return {
				id: `row-${String(index).padStart(6, "0")}`,
				slug: `row-${index}`,
				status: draft ? "draft" : "published",
				locale: "en",
				created_at: at,
				updated_at: at,
				published_at: draft ? null : at,
				deleted_at: index % 97 === 0 ? at : null,
				version: 1,
			};
		});
		for (let start = 0; start < rows.length; start += 200) {
			// oxlint-disable-next-line no-await-in-loop -- batches stay under the bind-parameter limit
			await ctx.db
				.insertInto("ec_post" as never)
				.values(rows.slice(start, start + 200) as never)
				.execute();
		}
		if (dialect === "postgres") await sql`ANALYZE ec_post`.execute(ctx.db);
	}

	async function adminListQuery() {
		captured = [];
		await new ContentRepository(db).findMany("post", { limit: 20 });
		return pageQuery();
	}

	async function listQueries() {
		const repo = new ContentRepository(db);
		captured = [];
		const first = await repo.findMany("post", { limit: 20 });
		const adminList = pageQuery();
		captured = [];
		await repo.findMany("post", { limit: 20, cursor: first.nextCursor });
		const adminNextPage = pageQuery();
		captured = [];
		await repo.findMany("post", { limit: 20, orderBy: { field: "updatedAt", direction: "desc" } });
		const adminByUpdated = pageQuery();
		return [
			adminList,
			adminNextPage,
			adminByUpdated,
			LATEST_PUBLISHED.compile(ctx.db),
			RECENTLY_UPDATED.compile(ctx.db),
		];
	}

	function pageQuery(): CompiledQuery {
		const page = captured.find((query) => /order by/i.test(query.sql));
		if (!page) throw new Error("findMany ran no ordered query");
		return page;
	}

	async function planOf(query: CompiledQuery): Promise<string> {
		const explain = dialect === "postgres" ? "EXPLAIN" : "EXPLAIN QUERY PLAN";
		const result = await ctx.db.executeQuery<Record<string, string>>(
			CompiledQuery.raw(`${explain} ${query.sql}`, query.parameters),
		);
		const column = dialect === "postgres" ? "QUERY PLAN" : "detail";
		return result.rows.map((row) => row[column]).join("\n");
	}

	async function expectOrderedByIndex(query: CompiledQuery): Promise<void> {
		const plan = await planOf(query);
		if (dialect === "postgres") {
			expect(plan).toMatch(/Index (Only )?Scan using idx_ec_post_live_(crt|upd|pub)/);
			expect(plan).not.toMatch(/Sort|Seq Scan/);
		} else {
			expect(plan).toMatch(/SEARCH ec_post USING (COVERING )?INDEX idx_ec_post_deleted_/);
			expect(plan).not.toMatch(/TEMP B-TREE|SCAN ec_post/);
		}
	}

	async function dropLiveIndexes(): Promise<void> {
		for (const name of LIVE_INDEXES) {
			// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
			await sql`DROP INDEX IF EXISTS ${sql.ref(name)}`.execute(ctx.db);
		}
	}

	async function liveIndexes(): Promise<string[]> {
		const result =
			dialect === "postgres"
				? await sql<{ name: string }>`
						SELECT indexname AS name FROM pg_indexes
						WHERE schemaname = current_schema() AND tablename = 'ec_post'
					`.execute(ctx.db)
				: await sql<{ name: string }>`
						SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ec_post'
					`.execute(ctx.db);
		return result.rows
			.map((row) => row.name)
			.filter((name) => LIVE_INDEXES.includes(name))
			.toSorted();
	}

	async function invalidIndexes(): Promise<string[]> {
		const result = await sql<{ name: string }>`
			SELECT index_class.relname AS name
			FROM pg_index AS idx
			JOIN pg_class AS index_class ON index_class.oid = idx.indexrelid
			JOIN pg_namespace AS ns ON ns.oid = index_class.relnamespace
			WHERE ns.nspname = current_schema() AND NOT idx.indisvalid
		`.execute(ctx.db);
		return result.rows.map((row) => row.name);
	}
});
