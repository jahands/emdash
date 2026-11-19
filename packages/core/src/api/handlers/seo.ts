/**
 * SEO Handlers
 *
 * Business logic for sitemap generation and robots.txt.
 */

import { sql, type Kysely } from "kysely";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";
import { validateIdentifier } from "../../database/validate.js";
import type { ApiResult } from "../types.js";

/** Raw content data for sitemap generation — the route builds the actual URLs */
export interface SitemapContentEntry {
	/** Content ID (ULID) */
	id: string;
	/** Content slug, or null when the entry has no slug */
	slug: string | null;
	/** ISO date of last modification */
	updatedAt: string;
	/**
	 * ISO publish date, or null when never published. Used to resolve
	 * date tokens (`{year}`/`{month}`/`{day}`) in the collection's
	 * `url_pattern` — the published date keeps permalinks stable across
	 * later edits (unlike `updatedAt`).
	 */
	publishedAt: string | null;
	/**
	 * Locale of this row (e.g. `"en"`, `"fr"`). Always present — rows in
	 * pre-i18n databases are backfilled to the configured `defaultLocale`.
	 */
	locale: string;
	/**
	 * `translation_group` ULID shared across all locale variants of the
	 * same content. Used by the sitemap route to emit `hreflang`
	 * alternates between siblings.
	 */
	translationGroup: string | null;
	/**
	 * Stored SEO image reference (`_emdash_seo.seo_image`), or null when
	 * the entry has no SEO image. The route resolves it to an absolute
	 * URL and emits it as an `<image:image>` sitemap entry.
	 */
	image: string | null;
}

/** Per-collection sitemap data with entries and URL pattern */
export interface SitemapCollectionData {
	/** Collection slug (e.g., "post", "page") */
	collection: string;
	/** URL pattern with {slug} placeholder, or null for default /{collection}/{slug} */
	urlPattern: string | null;
	/** Entries on the requested page */
	entries: SitemapContentEntry[];
	/**
	 * Indexable translations of `entries` that sit on other pages. They are
	 * not listed themselves but are needed for `hreflang` alternates.
	 */
	translations: SitemapContentEntry[];
}

export interface SitemapDataResponse {
	collections: SitemapCollectionData[];
}

/** One child sitemap in the sitemap index */
export interface SitemapIndexEntry {
	collection: string;
	/** 1-based page number */
	page: number;
	/** Most recent updated_at across the page's entries */
	lastmod: string;
}

/**
 * Entries per child sitemap. Collections with more indexable entries continue
 * at `/sitemap-{collection}-2.xml`, `-3.xml`, and so on.
 */
export const SITEMAP_PAGE_SIZE = 2000;

/** Matches a trailing timezone designator (`Z` or `±HH`, `±HHMM`, `±HH:MM`). */
const TZ_SUFFIX_RE = /([zZ]|[+-]\d{2}(:?\d{2})?)$/;

/**
 * Normalize a stored timestamp to W3C Datetime (ISO 8601) for sitemaps.
 *
 * `updated_at` is not guaranteed to be ISO: the column default is
 * `datetime('now')` on SQLite and `CURRENT_TIMESTAMP` on Postgres, both of
 * which store a space-separated `YYYY-MM-DD HH:MM:SS` string (and imported
 * content can carry other shapes). The sitemap `<lastmod>` field requires
 * W3C Datetime, and Google Search Console rejects the space-separated form
 * as "Invalid date". Normalize defensively, assuming UTC when no offset is
 * present (matches SQLite's `datetime('now')`). Valid date strings are
 * normalized to UTC ISO 8601; unparseable values are returned as-is.
 */
function toW3CDate(value: string): string {
	if (!value) return value;
	let normalized = value.trim();
	if (normalized.includes(" ") && !normalized.includes("T")) {
		normalized = normalized.replace(" ", "T");
	}
	if (!TZ_SUFFIX_RE.test(normalized)) {
		normalized += "Z";
	}
	const parsed = Date.parse(normalized);
	return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

interface SitemapCollectionRow {
	slug: string;
	url_pattern: string | null;
}

/** Routable, SEO-enabled collections with a valid slug (optionally one collection). */
async function getSitemapCollections(
	db: Kysely<Database>,
	collectionSlug?: string,
): Promise<SitemapCollectionRow[]> {
	let query = db
		.selectFrom("_emdash_collections")
		.select(["slug", "url_pattern"])
		.where("has_seo", "=", 1)
		.where("routable", "=", 1);

	if (collectionSlug) {
		query = query.where("slug", "=", collectionSlug);
	}

	const collections = await query.execute();
	return collections.filter((col) => {
		// Should always pass (slugs are validated on creation), but guards the
		// table-name identifier against corrupted DB data.
		try {
			validateIdentifier(col.slug, "collection slug");
			return true;
		} catch {
			console.warn(`[SITEMAP] Skipping collection with invalid slug: ${col.slug}`);
			return false;
		}
	});
}

/**
 * Published, non-deleted rows with a slug that are not marked noindex.
 * Content without an SEO row is indexable by default.
 */
function indexableRows(collection: string) {
	return sql`
		FROM ${sql.ref(`ec_${collection}`)} c
		LEFT JOIN _emdash_seo s
			ON s.collection = ${collection}
			AND s.content_id = c.id
		WHERE c.status = 'published'
		AND c.deleted_at IS NULL
		AND c.slug IS NOT NULL
		AND TRIM(c.slug) <> ''
		AND (s.seo_no_index IS NULL OR s.seo_no_index = 0)
	`;
}

/**
 * The same rows as `indexableRows`, written so Postgres reads them in ID order
 * from `idx_ec_{collection}_sitemap`, a partial index that covers every column
 * the sitemap lists, and excludes noindex entries through the small partial
 * index `idx_emdash_seo_no_index`. `NOT EXISTS` rather than `NOT IN`: Postgres
 * estimates `NOT IN` at half the rows and then prefers a scan and a sort.
 */
function indexableKeys(collection: string) {
	return sql`
		FROM ${sql.ref(`ec_${collection}`)} c
		WHERE c.status = 'published'
		AND c.deleted_at IS NULL
		AND c.slug IS NOT NULL
		AND TRIM(c.slug) <> ''
		AND NOT EXISTS (
			SELECT 1 FROM _emdash_seo noindex
			WHERE noindex.collection = ${collection}
			AND noindex.content_id = c.id
			AND noindex.seo_no_index <> 0
		)
	`;
}

/**
 * One row per page of indexable entries, with the page's latest update.
 *
 * Postgres walks the pages by key, one page of index entries per step, so
 * it reads each entry once and keeps no per-row window state. SQLite numbers
 * the rows instead: its planner does not read the partial index in order.
 */
function sitemapPagesQuery(db: Kysely<Database>, collection: string, pageSize: number) {
	if (isPostgres(db)) {
		const keys = indexableKeys(collection);
		return sql<{ page: number | string; lastmod: string }>`
			WITH RECURSIVE pages (page, last_id, lastmod) AS (
				SELECT 0, MAX(p.id), MAX(p.updated_at)
				FROM (SELECT c.id, c.updated_at ${keys} ORDER BY c.id LIMIT ${pageSize}) p
				UNION ALL
				SELECT prev.page + 1, step.last_id, step.lastmod
				FROM pages prev
				CROSS JOIN LATERAL (
					SELECT MAX(p.id) AS last_id, MAX(p.updated_at) AS lastmod
					FROM (
						SELECT c.id, c.updated_at ${keys} AND c.id > prev.last_id
						ORDER BY c.id LIMIT ${pageSize}
					) p
				) step
				WHERE prev.last_id IS NOT NULL
			)
			SELECT page, lastmod FROM pages WHERE last_id IS NOT NULL ORDER BY page
		`;
	}
	return sql<{ page: number | string; lastmod: string }>`
		SELECT p.page AS page, MAX(p.updated_at) AS lastmod
		FROM (
			SELECT c.updated_at,
				(ROW_NUMBER() OVER (ORDER BY c.id) - 1) / CAST(${pageSize} AS INTEGER) AS page
			${indexableRows(collection)}
		) p
		GROUP BY p.page
		ORDER BY p.page
	`;
}

/**
 * List the child sitemaps for the sitemap index: one per page of each
 * SEO-enabled collection that has indexable content, with the page's latest
 * update as `lastmod`.
 */
export async function handleSitemapIndexData(
	db: Kysely<Database>,
	pageSize = SITEMAP_PAGE_SIZE,
): Promise<ApiResult<{ sitemaps: SitemapIndexEntry[] }>> {
	try {
		const collections = await getSitemapCollections(db);
		const sitemaps: SitemapIndexEntry[] = [];

		for (const col of collections) {
			// A missing or broken table skips that collection instead of failing
			// the whole index.
			try {
				const rows = await sitemapPagesQuery(db, col.slug, pageSize).execute(db);

				for (const row of rows.rows) {
					sitemaps.push({
						collection: col.slug,
						page: Number(row.page) + 1,
						lastmod: toW3CDate(row.lastmod),
					});
				}
			} catch (err) {
				console.warn(`[SITEMAP] Failed to query collection "${col.slug}":`, err);
			}
		}

		return { success: true, data: { sitemaps } };
	} catch (error) {
		console.error("[SITEMAP_ERROR]", error);
		return {
			success: false,
			error: { code: "SITEMAP_ERROR", message: "Failed to generate sitemap index" },
		};
	}
}

interface SitemapPageRow {
	slug: string | null;
	id: string;
	updated_at: string;
	published_at: string | null;
	locale: string;
	translation_group: string | null;
	seo_image: string | null;
	on_page: number | string;
}

/**
 * The entries on one page, plus, with `includeTranslations`, the indexable
 * entries on other pages that share a translation group with one of them.
 */
function sitemapPageQuery(
	db: Kysely<Database>,
	collection: string,
	{
		pageSize,
		offset,
		includeTranslations,
	}: { pageSize: number; offset: number; includeTranslations: boolean },
) {
	if (isPostgres(db)) {
		const keys = indexableKeys(collection);
		const translations = includeTranslations
			? sql`
				UNION ALL
				SELECT c.id, c.slug, c.updated_at, c.published_at, c.locale, c.translation_group, 0
				${keys}
				AND c.translation_group IN (SELECT translation_group FROM page)
				AND c.id NOT IN (SELECT id FROM page)
			`
			: sql``;
		return sql<SitemapPageRow>`
			WITH page AS (
				SELECT c.id, c.slug, c.updated_at, c.published_at, c.locale, c.translation_group
				${keys}
				ORDER BY c.id
				LIMIT ${pageSize} OFFSET ${offset}
			),
			listed AS (
				SELECT page.*, 1 AS on_page FROM page
				${translations}
			)
			SELECT l.slug, l.id, l.updated_at, l.published_at, l.locale, l.translation_group,
				s.seo_image, l.on_page
			FROM listed l
			LEFT JOIN _emdash_seo s ON s.collection = ${collection} AND s.content_id = l.id
			ORDER BY l.id
		`;
	}
	const from = indexableRows(collection);
	const listed = includeTranslations
		? sql`
			c.id IN (SELECT id FROM page)
			OR c.translation_group IN (SELECT translation_group FROM page)
		`
		: sql`c.id IN (SELECT id FROM page)`;
	return sql<SitemapPageRow>`
		WITH page AS (
			SELECT c.id, c.translation_group
			${from}
			ORDER BY c.id
			LIMIT ${pageSize} OFFSET ${offset}
		)
		SELECT c.slug, c.id, c.updated_at, c.published_at, c.locale, c.translation_group,
			s.seo_image,
			CASE WHEN c.id IN (SELECT id FROM page) THEN 1 ELSE 0 END AS on_page
		${from}
		AND (${listed})
		ORDER BY c.id
	`;
}

/**
 * Collect one page of published, indexable content per SEO-enabled
 * collection for sitemap generation, ordered by ID so editing an entry does
 * not move it to another page.
 *
 * Returns raw data grouped per collection. The caller (route) is
 * responsible for building absolute URLs — this handler does NOT
 * assume a URL structure.
 */
export async function handleSitemapData(
	db: Kysely<Database>,
	/** When set, only return data for this collection. */
	collectionSlug?: string,
	options: {
		page?: number;
		pageSize?: number;
		/** Whether to return `translations`. Defaults to true. */
		includeTranslations?: boolean;
	} = {},
): Promise<ApiResult<SitemapDataResponse>> {
	const page = options.page ?? 1;
	const pageSize = options.pageSize ?? SITEMAP_PAGE_SIZE;
	const includeTranslations = options.includeTranslations ?? true;
	try {
		const collections = await getSitemapCollections(db, collectionSlug);
		const result: SitemapCollectionData[] = [];

		for (const col of collections) {
			// A missing or broken table skips that collection instead of failing
			// the whole sitemap.
			try {
				const rows = await sitemapPageQuery(db, col.slug, {
					pageSize,
					offset: (page - 1) * pageSize,
					includeTranslations,
				}).execute(db);

				const entries: SitemapContentEntry[] = [];
				const translations: SitemapContentEntry[] = [];
				for (const row of rows.rows) {
					const entry: SitemapContentEntry = {
						id: row.id,
						slug: row.slug,
						updatedAt: toW3CDate(row.updated_at),
						publishedAt: row.published_at ?? null,
						locale: row.locale,
						translationGroup: row.translation_group,
						image: row.seo_image ?? null,
					};
					(Number(row.on_page) === 1 ? entries : translations).push(entry);
				}

				if (entries.length === 0) continue;

				result.push({
					collection: col.slug,
					urlPattern: col.url_pattern,
					entries,
					translations,
				});
			} catch (err) {
				console.warn(`[SITEMAP] Failed to query collection "${col.slug}":`, err);
				continue;
			}
		}

		return { success: true, data: { collections: result } };
	} catch (error) {
		console.error("[SITEMAP_ERROR]", error);
		return {
			success: false,
			error: { code: "SITEMAP_ERROR", message: "Failed to generate sitemap data" },
		};
	}
}
