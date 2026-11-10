import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { beforeAll, beforeEach, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { createTestRuntime } from "../utils/mcp-runtime.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: "posts",
		label: "Posts",
		supports: ["drafts", "revisions"],
	});
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
});

it("stages a draft from a snapshot and answers with the written row on D1", async () => {
	const runtime = createTestRuntime(db);
	const created = await runtime.handleContentCreate("posts", { data: { title: "Live" } });
	if (!created.success) throw new Error(created.error.message);
	const id = created.data.item.id;

	const prepared = await runtime.handleContentGetForUpdate("posts", id);
	if (!prepared.success) throw new Error(prepared.error.message);
	const saved = await runtime.handleContentUpdate(
		"posts",
		id,
		{ data: { title: "Draft" }, _rev: prepared.data._rev },
		{ snapshot: prepared.data.snapshot },
	);

	expect(saved.success).toBe(true);
	if (!saved.success) return;
	expect(saved.data.item.data.title).toBe("Draft");
	expect(saved.data.item.version).toBe(prepared.data.item.version + 1);
	const row = await sql<{ draft_revision_id: string | null }>`
		SELECT draft_revision_id FROM ec_posts WHERE id = ${id}
	`.execute(db);
	expect(saved.data.item.draftRevisionId).toBe(row.rows[0]?.draft_revision_id);
});

it("refuses a stale snapshot on D1", async () => {
	const runtime = createTestRuntime(db);
	const created = await runtime.handleContentCreate("posts", { data: { title: "Live" } });
	if (!created.success) throw new Error(created.error.message);
	const id = created.data.item.id;
	const prepared = await runtime.handleContentGetForUpdate("posts", id);
	if (!prepared.success) throw new Error(prepared.error.message);
	await sql`UPDATE ec_posts SET updated_at = ${"2099-01-01T00:00:00.000Z"} WHERE id = ${id}`.execute(
		db,
	);

	const saved = await runtime.handleContentUpdate(
		"posts",
		id,
		{ data: { title: "Stale" }, _rev: prepared.data._rev },
		{ snapshot: prepared.data.snapshot },
	);

	expect(saved).toMatchObject({ success: false, error: { code: "CONFLICT" } });
});
