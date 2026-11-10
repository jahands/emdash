import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isPostgres, listTablesLike } from "../dialect-helpers.js";

/**
 * Partial indexes that keep live (`deleted_at IS NULL`) public listings on an
 * ordered index scan on PostgreSQL.
 *
 * PostgreSQL does not treat `IS NULL` as an equality that can remove a column
 * from an index's sort order, so the `(deleted_at, published_at DESC, id DESC)`
 * indexes can filter these listings but cannot return them in order. SQLite
 * can, so it needs no extra index and avoids the extra write per update.
 *
 * Index names stay within PostgreSQL's 63-byte identifier limit for slugs up to
 * 47 characters; keep them identical to `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;

	for (const tableName of await listTablesLike(db, "ec_%")) {
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_live_pub`)}
			ON ${sql.ref(tableName)} (published_at DESC, id DESC)
			WHERE deleted_at IS NULL
		`.execute(db);

		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(`idx_${tableName}_live_crt`)}
			ON ${sql.ref(tableName)} (created_at DESC, id DESC)
			WHERE deleted_at IS NULL
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;

	for (const tableName of await listTablesLike(db, "ec_%")) {
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_live_pub`)}`.execute(db);
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_live_crt`)}`.execute(db);
	}
}
