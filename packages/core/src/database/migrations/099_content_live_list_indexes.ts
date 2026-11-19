import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isPostgres, listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: give Postgres content tables list indexes it can read in order.
 *
 * Content lists filter `deleted_at IS NULL` and order by a timestamp then `id`.
 * Postgres does not treat `IS NULL` as an equality when it matches an ORDER BY
 * to an index, so the `deleted_at`-led composites from migrations 033 and 041
 * only filter: every list reads all live rows and sorts them. Partial indexes
 * keyed on the sort columns let a list stop after its page.
 *
 * SQLite treats `IS NULL` as an equality and already orders lists from the
 * existing composites, so this migration changes nothing there.
 *
 * `CREATE INDEX` runs inside the migration transaction and blocks writes to
 * each table, not reads, until the migration commits. A site with large tables
 * can build the indexes beforehand with `CREATE INDEX CONCURRENTLY` under these
 * names; `IF NOT EXISTS` then skips them. An interrupted concurrent build
 * leaves an invalid index that `IF NOT EXISTS` would also skip, so invalid
 * indexes with these names are rebuilt.
 *
 * Keep the names and definitions identical to `schema/registry.ts`.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;

	const tableNames = await listTablesLike(db, "ec_%");
	const invalid = await invalidIndexNames(db);

	for (const tableName of tableNames) {
		for (const index of liveListIndexes(tableName)) {
			if (invalid.has(index.name)) {
				// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
				await sql`DROP INDEX IF EXISTS ${sql.ref(index.name)}`.execute(db);
			}
			// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
			await sql`
				CREATE INDEX IF NOT EXISTS ${sql.ref(index.name)}
				ON ${sql.ref(tableName)} ${index.columns}
				WHERE deleted_at IS NULL
			`.execute(db);
		}
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;

	const tableNames = await listTablesLike(db, "ec_%");
	for (const tableName of tableNames) {
		for (const index of liveListIndexes(tableName)) {
			// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
			await sql`DROP INDEX IF EXISTS ${sql.ref(index.name)}`.execute(db);
		}
	}
}

function liveListIndexes(tableName: string) {
	return [
		{ name: `idx_${tableName}_live_crt`, columns: sql`(created_at DESC, id DESC)` },
		{ name: `idx_${tableName}_live_upd`, columns: sql`(updated_at DESC, id DESC)` },
		{ name: `idx_${tableName}_live_pub`, columns: sql`(status, published_at DESC, id DESC)` },
	];
}

async function invalidIndexNames(db: Kysely<unknown>): Promise<Set<string>> {
	const result = await sql<{ name: string }>`
		SELECT index_class.relname AS name
		FROM pg_index AS idx
		JOIN pg_class AS index_class ON index_class.oid = idx.indexrelid
		JOIN pg_namespace AS ns ON ns.oid = index_class.relnamespace
		WHERE ns.nspname = current_schema() AND NOT idx.indisvalid
	`.execute(db);
	return new Set(result.rows.map((row) => row.name));
}
