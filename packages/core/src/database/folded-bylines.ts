import { type Kysely, type RawBuilder, sql } from "kysely";

import { getI18nConfig } from "../i18n/config.js";
import { canonicalLocaleColumn, storedLocaleOrder } from "../i18n/query.js";
import { isPostgres } from "./dialect-helpers.js";
import type { BylineSummary, ContentBylineCredit } from "./repositories/types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Correlated subqueries that read an entry's bylines in the statement that
 * reads the entry: `credits`, a JSON array of its explicit credits, and
 * `author`, the byline linked to its author in its locale (the fallback for
 * an entry without credits), or NULL. `fieldsVersion` is the byline schema
 * version, for `primeBylineFieldsVersion`. Each correlates on `<outer>.id`,
 * `<outer>.author_id` and `<outer>.locale`, so the outer query stays one row
 * per entry.
 *
 * Credits are not ordered in the aggregate (ordering differs across
 * dialects); `creditsFromFoldedBylines` sorts them by `sortOrder`. SQLite
 * returns each value as JSON text and Postgres as parsed JSON.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any Kysely instance
export function foldedBylineSubqueries(db: Kysely<any>, type: string, outer: string) {
	const o = sql.ref(outer);
	const pg = isPostgres(db);
	const obj = (pairs: string) =>
		pg ? sql.raw(`json_build_object(${pairs})`) : sql.raw(`json_object(${pairs})`);
	const agg = (inner: RawBuilder<unknown>) =>
		pg ? sql`coalesce(json_agg(${inner}), '[]'::json)` : sql`json_group_array(${inner})`;
	const hasLocaleAliases = Object.keys(getI18nConfig()?.localeAliases ?? {}).length > 0;

	// Pin the byline join order on SQLite. SQLite honours `CROSS JOIN`
	// ordering, forcing the subquery to drive from its pivot by content
	// reference and probe by translation_group. Postgres keeps statistics and
	// rejects `CROSS JOIN … ON`, so it stays a plain JOIN.
	const foldJoin = pg ? sql`JOIN` : sql`CROSS JOIN`;

	const bylineInner = obj(
		"'id', b.id, 'slug', b.slug, 'displayName', b.display_name, 'bio', b.bio, 'avatarMediaId', b.avatar_media_id, 'avatarStorageKey', m.storage_key, 'avatarAlt', m.alt, 'avatarBlurhash', m.blurhash, 'avatarDominantColor', m.dominant_color, 'websiteUrl', b.website_url, 'userId', b.user_id, 'isGuest', b.is_guest, 'createdAt', b.created_at, 'updatedAt', b.updated_at, 'locale', b.locale, 'translationGroup', b.translation_group",
	);
	const creditObj = pg
		? sql.raw(
				"json_build_object('roleLabel', cb.role_label, 'sortOrder', cb.sort_order, 'byline', ",
			)
		: sql.raw("json_object('roleLabel', cb.role_label, 'sortOrder', cb.sort_order, 'byline', ");
	const credit = sql`${creditObj}${bylineInner})`;
	// The locale match differs with locale aliases: a row's locale may be any
	// of its configured locale's codes, so both subqueries compare canonical
	// locales and pick one byline per match, as the query path does.
	const credits = hasLocaleAliases
		? sql`(SELECT ${agg(credit)} FROM ${sql.ref("_emdash_content_bylines")} AS cb
		${foldJoin} ${sql.ref("_emdash_bylines")} AS b ON b.id = (
			SELECT candidate.id FROM _emdash_bylines AS candidate
			WHERE candidate.translation_group = cb.byline_id
				AND ${canonicalLocaleColumn("candidate.locale")} = ${canonicalLocaleColumn(`${outer}.locale`)}
			ORDER BY ${storedLocaleOrder("candidate.locale")}, candidate.id LIMIT 1
		)
		LEFT JOIN ${sql.ref("media")} AS m ON m.id = b.avatar_media_id
		WHERE cb.collection_slug = ${type} AND cb.content_id = ${o}.id)`
		: sql`(SELECT ${agg(credit)} FROM ${sql.ref("_emdash_content_bylines")} AS cb ${foldJoin} ${sql.ref("_emdash_bylines")} AS b ON b.translation_group = cb.byline_id LEFT JOIN ${sql.ref("media")} AS m ON m.id = b.avatar_media_id WHERE cb.collection_slug = ${type} AND cb.content_id = ${o}.id AND b.locale = ${o}.locale)`;
	// The author fallback for an entry with no explicit credit: the byline
	// linked to its author in its locale. Without aliases `(user_id, locale)`
	// is unique, so this is one index probe per row and matches
	// `findByUserIds` exactly; with them, the same canonical-locale match and
	// ordering as the credits above picks one.
	const author = hasLocaleAliases
		? sql`(SELECT ${bylineInner} FROM ${sql.ref("_emdash_bylines")} AS b LEFT JOIN ${sql.ref("media")} AS m ON m.id = b.avatar_media_id
		WHERE b.user_id = ${o}.author_id
			AND ${canonicalLocaleColumn("b.locale")} = ${canonicalLocaleColumn(`${outer}.locale`)}
		ORDER BY ${storedLocaleOrder("b.locale")}, b.id LIMIT 1)`
		: sql`(SELECT ${bylineInner} FROM ${sql.ref("_emdash_bylines")} AS b LEFT JOIN ${sql.ref("media")} AS m ON m.id = b.avatar_media_id WHERE b.user_id = ${o}.author_id AND b.locale = ${o}.locale LIMIT 1)`;
	const fieldsVersion = sql`(SELECT value FROM ${sql.ref("options")} WHERE name = ${"byline_fields_version"})`;
	return { credits, author, fieldsVersion };
}

/**
 * A folded byline object as a `BylineSummary`. The fold's JSON keys are the
 * `BylineSummary` keys (see `bylineInner` in {@link foldedHydrationSelects}).
 */
function foldedBylineSummary(raw: unknown): BylineSummary {
	const byline = isPlainObject(raw) ? raw : {};
	// Folded rows omit custom-field values.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- keys set by the fold's SQL
	return { ...byline, isGuest: Boolean(byline.isGuest), customFields: {} } as BylineSummary;
}

export function creditsFromFoldedBylines(folded: unknown[]): ContentBylineCredit[] {
	return folded
		.map((raw) => {
			const credit = isPlainObject(raw) ? raw : {};
			return {
				roleLabel: typeof credit.roleLabel === "string" ? credit.roleLabel : null,
				sortOrder: Number(credit.sortOrder ?? 0),
				source: "explicit" as const,
				byline: foldedBylineSummary(credit.byline),
			};
		})
		.toSorted((a, b) => a.sortOrder - b.sortOrder);
}

/** The inferred credit for a folded author-fallback byline. */
export function creditFromFoldedAuthorByline(raw: Record<string, unknown>): ContentBylineCredit {
	return { byline: foldedBylineSummary(raw), sortOrder: 0, roleLabel: null, source: "inferred" };
}
