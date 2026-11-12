import type { Kysely } from "kysely";
import { sql } from "kysely";

import { isPostgres, listTablesLike } from "../dialect-helpers.js";

/**
 * Migration: let Postgres build sitemaps from indexes.
 *
 * Sitemaps list a collection's indexable entries in ID order, in pages. Without
 * an index in that order Postgres read every live row of the table, and its
 * estimate of the noindex filter through the `_emdash_seo` join led it to scan
 * and sort. A partial index over indexable entries, keyed on `id` and covering
 * the listed columns, lets it walk pages from the index alone. A partial index
 * over noindex SEO rows, which are rare, keeps the noindex check from reading
 * every SEO row of the collection.
 *
 * SQLite keeps its existing sitemap queries, so this migration changes nothing
 * there.
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

	const invalid = await invalidIndexNames(db);
	const rebuild = async (name: string) => {
		if (invalid.has(name)) await sql`DROP INDEX IF EXISTS ${sql.ref(name)}`.execute(db);
	};

	await rebuild("idx_emdash_seo_no_index");
	await sql`
		CREATE INDEX IF NOT EXISTS idx_emdash_seo_no_index
		ON _emdash_seo (collection, content_id)
		WHERE seo_no_index <> 0
	`.execute(db);

	for (const tableName of await listTablesLike(db, "ec_%")) {
		const name = `idx_${tableName}_sitemap`;
		// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
		await rebuild(name);
		// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
		await sql`
			CREATE INDEX IF NOT EXISTS ${sql.ref(name)}
			ON ${sql.ref(tableName)} (id)
			INCLUDE (updated_at, translation_group, slug, published_at, locale)
			WHERE status = 'published' AND deleted_at IS NULL AND slug IS NOT NULL AND TRIM(slug) <> ''
		`.execute(db);
	}
}

export async function down(db: Kysely<unknown>): Promise<void> {
	if (!isPostgres(db)) return;

	for (const tableName of await listTablesLike(db, "ec_%")) {
		// oxlint-disable-next-line no-await-in-loop -- DDL runs one statement at a time
		await sql`DROP INDEX IF EXISTS ${sql.ref(`idx_${tableName}_sitemap`)}`.execute(db);
	}
	await sql`DROP INDEX IF EXISTS idx_emdash_seo_no_index`.execute(db);
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
