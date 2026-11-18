import { sql, type Kysely, type RawBuilder } from "kysely";

import {
	parseGeneration,
	PLUGIN_STATE_COLUMNS,
	PLUGIN_STATE_GENERATION_OPTION,
	type PluginStateRow,
} from "../plugins/state.js";
import type { VersionedValue } from "../plugins/types.js";
import {
	BYLINE_FIELDS_VERSION_KEY,
	mapFieldRow,
	parseBylineFieldsVersion,
} from "../schema/byline-registry.js";
import type { BylineFieldDefinition } from "../schema/types.js";
import { isPostgres } from "./dialect-helpers.js";
import type { Database } from "./types.js";

type BylineFieldRow = Parameters<typeof mapFieldRow>[0];

const BYLINE_FIELD_COLUMNS = [
	"id",
	"slug",
	"label",
	"type",
	"required",
	"translatable",
	"validation",
	"sort_order",
	"created_at",
	"updated_at",
] as const satisfies readonly (keyof BylineFieldRow)[];

type UnlistedBylineFieldColumn = Exclude<
	keyof BylineFieldRow,
	(typeof BYLINE_FIELD_COLUMNS)[number]
>;
const bylineFieldColumnsComplete: [UnlistedBylineFieldColumn] extends [never] ? true : never = true;
void bylineFieldColumnsComplete;

/** A taxonomy definition row as `selectTaxonomyDefs` reads it. */
export interface ColdStartTaxonomyDefRow {
	id: string;
	name: string;
	label: string;
	label_singular: string | null;
	created_at: string;
	locale: string;
	translation_group: string | null;
	hierarchical: number;
	collections: string | null;
}

const TAXONOMY_DEF_COLUMNS = [
	"id",
	"name",
	"label",
	"label_singular",
	"created_at",
	"locale",
	"translation_group",
	"hierarchical",
	"collections",
] as const satisfies readonly (keyof ColdStartTaxonomyDefRow)[];

/** What a runtime needs from the database before it can serve its first request. */
export interface ColdStartState {
	appliedMigrationCount: number;
	pluginStates: PluginStateRow[];
	pluginStateGeneration: bigint;
	collectionSlugs: string[];
	/** The requested options that are set, parsed. */
	options: Map<string, unknown>;
	/** Options whose names start with `prefix`, parsed, with their revisions. */
	prefixedOptions: Map<string, VersionedValue>;
	bylineFieldsVersion: number;
	/** In `BylineSchemaRegistry.listFields()` order. */
	bylineFields: BylineFieldDefinition[];
	/** Every locale's taxonomy definitions, by name, then locale. */
	taxonomyDefs: ColdStartTaxonomyDefRow[];
}

function escapeLike(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function parseJsonColumn(value: unknown): unknown[] {
	const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
	if (!Array.isArray(parsed)) throw new Error("Cold-start read returned a non-array column");
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the applied-migration count, plugin states and their generation,
 * collection slugs, the given options, the byline field definitions and the
 * taxonomy definitions in one statement, so a cold start pays one round trip for them. Throws when any of the tables is missing, as on a database that has
 * not been migrated; callers fall back to separate reads.
 */
export async function readColdStartState(
	db: Kysely<Database>,
	optionNames: readonly string[],
	prefix: string,
): Promise<ColdStartState> {
	const pg = isPostgres(db);
	const agg = (value: RawBuilder<unknown>) =>
		pg ? sql`coalesce(json_agg(${value}), '[]'::json)::text` : sql`json_group_array(${value})`;
	const array = (...values: RawBuilder<unknown>[]) =>
		pg ? sql`json_build_array(${sql.join(values)})` : sql`json_array(${sql.join(values)})`;
	const object = (columns: readonly string[]) => {
		const pairs = sql.join(columns.map((column) => sql`${sql.lit(column)}, ${sql.ref(column)}`));
		return pg ? sql`json_build_object(${pairs})` : sql`json_object(${pairs})`;
	};
	const bylineFieldObject = object(BYLINE_FIELD_COLUMNS);
	const bylineFields = pg
		? sql`(select coalesce(json_agg(${bylineFieldObject} order by sort_order, created_at), '[]'::json)::text from ${sql.ref("_emdash_byline_fields")})`
		: sql`(select json_group_array(${bylineFieldObject}) from (select * from ${sql.ref("_emdash_byline_fields")} order by sort_order, created_at))`;
	// The columns and fallbacks of `selectTaxonomyDefs`.
	const taxonomyDefRows = sql`(
		select d.id, d.name, d.label, d.label_singular, d.created_at, d.locale, d.translation_group,
			coalesce(g.hierarchical, d.hierarchical) as hierarchical,
			coalesce(g.collections, d.collections) as collections
		from ${sql.ref("_emdash_taxonomy_defs")} as d
		left join ${sql.ref("_emdash_taxonomy_def_groups")} as g on g.name = d.name
	)`;
	const taxonomyDefObject = object(TAXONOMY_DEF_COLUMNS);
	const taxonomyDefs = pg
		? sql`(select coalesce(json_agg(${taxonomyDefObject} order by name, locale), '[]'::json)::text from ${taxonomyDefRows} as t)`
		: sql`(select json_group_array(${taxonomyDefObject}) from (select * from ${taxonomyDefRows} order by name, locale))`;
	const namedOptions =
		optionNames.length > 0
			? sql`(select ${agg(array(sql.ref("name"), sql.ref("value")))} from options where name in (${sql.join([...optionNames])}))`
			: sql`'[]'`;

	const result = await sql<{
		applied_migrations: number | string;
		plugin_states: unknown;
		plugin_state_generation: string | null;
		collections: unknown;
		named_options: unknown;
		prefixed_options: unknown;
		byline_fields_version: string | null;
		byline_fields: unknown;
		taxonomy_defs: unknown;
	}>`select
			(select count(*) from ${sql.ref("_emdash_migrations")}) as applied_migrations,
			(select ${agg(object(PLUGIN_STATE_COLUMNS))} from ${sql.ref("_plugin_state")}) as plugin_states,
			(select value from options where name = ${PLUGIN_STATE_GENERATION_OPTION}) as plugin_state_generation,
			(select ${agg(sql.ref("slug"))} from ${sql.ref("_emdash_collections")}) as collections,
			${namedOptions} as named_options,
			(
				select ${agg(array(sql.ref("name"), sql.ref("value"), sql.ref("revision")))}
				from options
				where name like ${`${escapeLike(prefix)}%`} escape '\\'
			) as prefixed_options,
			(select value from options where name = ${BYLINE_FIELDS_VERSION_KEY}) as byline_fields_version,
			${bylineFields} as byline_fields,
			${taxonomyDefs} as taxonomy_defs
	`.execute(db);
	const row = result.rows[0];
	if (!row) throw new Error("Cold-start read returned no row");

	const pluginStates = parseJsonColumn(row.plugin_states)
		.filter(isRecord)
		.map((state) => ({
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- built from PLUGIN_STATE_COLUMNS
			...(state as unknown as PluginStateRow),
			mcp_tools_enabled: Number(state.mcp_tools_enabled),
		}));
	const collectionSlugs = parseJsonColumn(row.collections).filter(
		(slug): slug is string => typeof slug === "string",
	);
	const options = new Map<string, unknown>();
	for (const entry of parseJsonColumn(row.named_options)) {
		if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
			continue;
		}
		options.set(entry[0], JSON.parse(entry[1]));
	}
	const prefixedOptions = new Map<string, VersionedValue>();
	const prefixed = parseJsonColumn(row.prefixed_options).filter(
		(entry): entry is [string, string, string] =>
			Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string",
	);
	for (const [name, value, revision] of prefixed.toSorted(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		prefixedOptions.set(name, { value: JSON.parse(value), revision });
	}

	const bylineFieldRows = parseJsonColumn(row.byline_fields).filter(isRecord);

	return {
		appliedMigrationCount: Number(row.applied_migrations),
		pluginStates,
		pluginStateGeneration: parseGeneration(row.plugin_state_generation),
		collectionSlugs,
		options,
		prefixedOptions,
		bylineFieldsVersion: parseBylineFieldsVersion(row.byline_fields_version),
		bylineFields: bylineFieldRows.map((field) =>
			mapFieldRow({
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- built from BYLINE_FIELD_COLUMNS
				...(field as unknown as BylineFieldRow),
				required: Number(field.required),
				translatable: Number(field.translatable),
				sort_order: Number(field.sort_order),
			}),
		),
		taxonomyDefs: parseJsonColumn(row.taxonomy_defs)
			.filter(isRecord)
			.map((def) => ({
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- built from TAXONOMY_DEF_COLUMNS
				...(def as unknown as ColdStartTaxonomyDefRow),
				hierarchical: Number(def.hierarchical),
			})),
	};
}
