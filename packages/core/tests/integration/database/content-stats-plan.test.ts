import { CompiledQuery, Kysely } from "kysely";
import { afterEach, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { NodeSqliteDialect, openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

let db: Kysely<Database> | undefined;

afterEach(async () => {
	await db?.destroy();
	db = undefined;
});

it("counts a collection's entries from indexes alone", async () => {
	const queries: CompiledQuery[] = [];
	db = new Kysely<Database>({
		dialect: new NodeSqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
		log: (event) => queries.push(event.query),
	});
	await runMigrations(db);
	await new SchemaRegistry(db).createCollection({ slug: "post", label: "Posts" });
	queries.length = 0;

	await new ContentRepository(db).getStats("post");

	expect(queries).toHaveLength(1);
	const [stats] = queries;
	const plan = await db.executeQuery<{ detail: string }>(
		CompiledQuery.raw(`EXPLAIN QUERY PLAN ${stats!.sql}`, [...stats!.parameters]),
	);
	const tableReads = plan.rows
		.map((row) => row.detail)
		.filter((detail) => detail.includes("ec_post"));
	expect(tableReads.length).toBeGreaterThan(0);
	for (const read of tableReads) expect(read).toContain("COVERING INDEX");
});
