import { type Kysely, sql } from "kysely";

import type { Database } from "../../src/database/types.js";

/**
 * Generate and compare the squashed migration baseline.
 *
 * `generate*Baseline` read a database that ran every migration and return the
 * statements that rebuild it on an empty database. `describeSchema` returns
 * everything a database's schema and rows consist of, in a form two databases
 * can be compared by.
 */

export const BOOKKEEPING_TABLES = new Set(["_emdash_migrations", "_emdash_migrations_lock"]);

/** Names here are interpolated into raw SQL; they come from the catalog. */
const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
	if (!SAFE_NAME.test(name)) throw new Error(`Unexpected object name: ${name}`);
	return `"${name}"`;
}

/** The window in which the compared databases were built. */
export interface BuildWindow {
	start: Date;
	end: Date;
}

type TimeFormat = "sqlite-datetime" | "iso" | "pg-timestamptz";

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PG_TIMESTAMPTZ =
	/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;

/**
 * Whether `value` is the time the database was built, as a column default or
 * a migration wrote it, and in which format.
 */
function buildTimeFormat(value: string, window: BuildWindow): TimeFormat | null {
	let format: TimeFormat;
	let time: number;
	const pg = PG_TIMESTAMPTZ.exec(value);
	if (SQLITE_DATETIME.test(value)) {
		format = "sqlite-datetime";
		time = Date.parse(`${value.replace(" ", "T")}Z`);
	} else if (ISO_MILLIS.test(value)) {
		format = "iso";
		time = Date.parse(value);
	} else if (pg) {
		format = "pg-timestamptz";
		time = Date.parse(`${pg[1]}T${pg[2]}${pg[3]}:${pg[4] ?? "00"}`);
	} else {
		return null;
	}
	const slack = 2_000;
	return time >= window.start.getTime() - slack && time <= window.end.getTime() + slack
		? format
		: null;
}

const NOW_EXPRESSIONS: Record<"sqlite" | "postgres", Partial<Record<TimeFormat, string>>> = {
	sqlite: {
		"sqlite-datetime": "datetime('now')",
		iso: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
	},
	postgres: {
		"pg-timestamptz": "CURRENT_TIMESTAMP",
		iso: `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
	},
};

/** A quoted SQL literal, or the expression that writes the current time in the same format. */
function literalOrNow(
	quoted: string | null,
	dialect: "sqlite" | "postgres",
	window: BuildWindow,
): string {
	if (quoted === null) return "NULL";
	const match = /^'(.*)'$/s.exec(quoted);
	if (match?.[1] !== undefined) {
		const format = buildTimeFormat(match[1], window);
		if (format) {
			const expression = NOW_EXPRESSIONS[dialect][format];
			if (!expression) throw new Error(`No ${dialect} expression for ${format} times`);
			return expression;
		}
	}
	return quoted;
}

function normalizeValue(value: unknown, window: BuildWindow): unknown {
	if (typeof value === "string") {
		const format = buildTimeFormat(value, window);
		return format ? `<build time: ${format}>` : value;
	}
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Uint8Array) return `<bytes: ${Buffer.from(value).toString("hex")}>`;
	return value;
}

function sortedRows(rows: Record<string, unknown>[], window: BuildWindow): unknown[] {
	return rows
		.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, value]) => [key, normalizeValue(value, window)]),
			),
		)
		.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

// ---------------------------------------------------------------------------
// SQLite (and D1)
// ---------------------------------------------------------------------------

interface SqliteObject {
	type: string;
	name: string;
	tbl_name: string;
	sql: string | null;
}

async function sqliteObjects(db: Kysely<Database>): Promise<SqliteObject[]> {
	const { rows } = await sql<SqliteObject>`
		SELECT type, name, tbl_name, sql FROM sqlite_master
		WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
		ORDER BY rowid
	`.execute(db);
	const virtual = rows
		.filter((row) => row.type === "table" && row.sql?.startsWith("CREATE VIRTUAL TABLE"))
		.map((row) => row.name);
	return rows.filter(
		(row) =>
			!(row.type === "table" && virtual.some((name) => row.name.startsWith(`${name}_`))) &&
			!BOOKKEEPING_TABLES.has(row.tbl_name),
	);
}

async function sqliteColumns(db: Kysely<Database>, table: string): Promise<string[]> {
	const { rows } = await sql<{ name: string }>`
		SELECT name FROM pragma_table_info(${table}) ORDER BY cid
	`.execute(db);
	return rows.map((row) => row.name);
}

export async function generateSqliteBaseline(
	db: Kysely<Database>,
	window: BuildWindow,
): Promise<string[]> {
	const objects = await sqliteObjects(db);
	const sqlOf = (type: string) =>
		objects.filter((o) => o.type === type && o.sql !== null).map((o) => o.sql as string);

	const data: string[] = [];
	for (const table of objects.filter((o) => o.type === "table")) {
		const columns = await sqliteColumns(db, table.name);
		const { rows } = await sql<Record<string, string | null>>`
			SELECT ${sql.raw(columns.map((c) => `quote(${ident(c)}) AS ${ident(c)}`).join(", "))}
			FROM ${sql.raw(ident(table.name))}
		`.execute(db);
		if (rows.length === 0) continue;
		const values = rows
			.map(
				(row) =>
					`(${columns.map((c) => literalOrNow(row[c] ?? null, "sqlite", window)).join(", ")})`,
			)
			.toSorted();
		data.push(
			`INSERT INTO ${ident(table.name)} (${columns.map(ident).join(", ")}) VALUES ${values.join(", ")}`,
		);
	}

	// Rows go in before triggers exist: the migrations wrote them without the
	// triggers that later migrations added.
	return [...sqlOf("table"), ...data, ...sqlOf("index"), ...sqlOf("view"), ...sqlOf("trigger")];
}

async function describeSqlite(db: Kysely<Database>, window: BuildWindow): Promise<unknown> {
	const { rows: objects } = await sql<SqliteObject>`
		SELECT type, name, tbl_name, sql FROM sqlite_master
		WHERE name NOT LIKE '_cf_%'
	`.execute(db);
	const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
	const columns: Record<string, unknown> = {};
	const foreignKeys: Record<string, unknown> = {};
	const data: Record<string, unknown> = {};
	for (const table of tables.toSorted()) {
		columns[table] = (
			await sql<Record<string, unknown>>`SELECT * FROM pragma_table_xinfo(${table})`.execute(db)
		).rows;
		foreignKeys[table] = (
			await sql<Record<string, unknown>>`SELECT * FROM pragma_foreign_key_list(${table})`.execute(
				db,
			)
		).rows;
		if (table === "sqlite_sequence") continue;
		data[table] = await describeRows(db, table, window);
	}
	return {
		objects: objects
			.map((o) => ({ ...o }))
			.toSorted((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`)),
		columns,
		foreignKeys,
		data,
	};
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

function unqualify(text: string, schema: string): string {
	return text.replaceAll(`"${schema}".`, "").replaceAll(`${schema}.`, "");
}

async function assertSupportedPostgresSchema(db: Kysely<Database>, schema: string): Promise<void> {
	const { rows } = await sql<{ relname: string; relkind: string }>`
		SELECT relname, relkind FROM pg_class
		WHERE relnamespace = ${schema}::regnamespace AND relkind NOT IN ('r', 'i')
	`.execute(db);
	const unusual = await sql<{ attname: string; relname: string }>`
		SELECT a.attname, c.relname FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_type t ON t.oid = a.atttypid
		WHERE c.relnamespace = ${schema}::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
			AND (a.attidentity <> '' OR a.attgenerated <> '' OR a.attcollation <> t.typcollation)
	`.execute(db);
	const types = await sql<{ typname: string }>`
		SELECT typname FROM pg_type
		WHERE typnamespace = ${schema}::regnamespace AND typtype <> 'c' AND typelem = 0 AND typrelid = 0
	`.execute(db);
	const problems = [
		...rows.map((r) => `${r.relname} (relkind ${r.relkind})`),
		...unusual.rows.map((r) => `${r.relname}.${r.attname} (identity, generated or collation)`),
		...types.rows.map((r) => `type ${r.typname}`),
	];
	if (problems.length > 0) {
		throw new Error(
			`The baseline generator does not handle these objects yet: ${problems.join(", ")}`,
		);
	}
}

interface PgColumn {
	attname: string;
	type: string;
	attnotnull: boolean;
	def: string | null;
	notnull_name: string | null;
}

export async function generatePostgresBaseline(
	db: Kysely<Database>,
	schema: string,
	window: BuildWindow,
): Promise<string[]> {
	await assertSupportedPostgresSchema(db, schema);
	const { rows: tables } = await sql<{ oid: number; relname: string }>`
		SELECT oid, relname FROM pg_class
		WHERE relnamespace = ${schema}::regnamespace AND relkind = 'r'
		ORDER BY oid
	`.execute(db);

	const creates: string[] = [];
	const data: string[] = [];
	const foreignKeys: string[] = [];
	for (const table of tables) {
		if (BOOKKEEPING_TABLES.has(table.relname)) continue;
		const { rows: columns } = await sql<PgColumn>`
			SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
				pg_get_expr(d.adbin, d.adrelid) AS def,
				(SELECT conname FROM pg_constraint
					WHERE conrelid = a.attrelid AND contype = 'n' AND conkey = ARRAY[a.attnum]) AS notnull_name
			FROM pg_attribute a
			LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = ${table.oid} AND a.attnum > 0 AND NOT a.attisdropped
			ORDER BY a.attnum
		`.execute(db);
		const { rows: constraints } = await sql<{ conname: string; contype: string; def: string }>`
			SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
			WHERE conrelid = ${table.oid} AND contype <> 'n'
			ORDER BY oid
		`.execute(db);

		const lines = columns.map((c) => {
			let line = `${ident(c.attname)} ${c.type}`;
			if (c.def !== null) line += ` DEFAULT ${unqualify(c.def, schema)}`;
			if (c.attnotnull) {
				const defaultName = `${table.relname}_${c.attname}_not_null`;
				line +=
					c.notnull_name && c.notnull_name !== defaultName
						? ` CONSTRAINT ${ident(c.notnull_name)} NOT NULL`
						: " NOT NULL";
			}
			return line;
		});
		for (const constraint of constraints) {
			const definition = `CONSTRAINT ${ident(constraint.conname)} ${unqualify(constraint.def, schema)}`;
			if (constraint.contype === "f") {
				foreignKeys.push(`ALTER TABLE ${ident(table.relname)} ADD ${definition}`);
			} else {
				lines.push(definition);
			}
		}
		creates.push(`CREATE TABLE ${ident(table.relname)} (\n\t${lines.join(",\n\t")}\n)`);

		const names = columns.map((c) => c.attname);
		const { rows } = await sql<Record<string, string | null>>`
			SELECT ${sql.raw(names.map((c) => `quote_nullable(${ident(c)}) AS ${ident(c)}`).join(", "))}
			FROM ${sql.raw(ident(table.relname))}
		`.execute(db);
		if (rows.length > 0) {
			const values = rows
				.map(
					(row) =>
						`(${names.map((c) => literalOrNow(row[c] ?? null, "postgres", window)).join(", ")})`,
				)
				.toSorted();
			data.push(
				`INSERT INTO ${ident(table.relname)} (${names.map(ident).join(", ")}) VALUES ${values.join(", ")}`,
			);
		}
	}

	const { rows: indexes } = await sql<{ def: string; relname: string }>`
		SELECT pg_get_indexdef(i.indexrelid) AS def, t.relname FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_class t ON t.oid = i.indrelid
		WHERE c.relnamespace = ${schema}::regnamespace
			AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conindid = i.indexrelid AND contype IN ('p', 'u', 'x'))
		ORDER BY i.indexrelid
	`.execute(db);
	const { rows: functions } = await sql<{ def: string }>`
		SELECT pg_get_functiondef(oid) AS def FROM pg_proc
		WHERE pronamespace = ${schema}::regnamespace
		ORDER BY oid
	`.execute(db);
	const { rows: triggers } = await sql<{ def: string; tgenabled: string }>`
		SELECT pg_get_triggerdef(t.oid) AS def, t.tgenabled FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		WHERE c.relnamespace = ${schema}::regnamespace AND NOT t.tgisinternal
		ORDER BY t.oid
	`.execute(db);
	if (triggers.some((t) => t.tgenabled !== "O")) {
		throw new Error("The baseline generator does not handle disabled triggers yet");
	}

	return [
		...creates,
		...data,
		...foreignKeys,
		...indexes
			.filter((i) => !BOOKKEEPING_TABLES.has(i.relname))
			.map((i) => unqualify(i.def, schema)),
		...functions.map((f) => unqualify(f.def, schema).trim()),
		...triggers.map((t) => unqualify(t.def, schema)),
	];
}

async function describePostgres(
	db: Kysely<Database>,
	schema: string,
	window: BuildWindow,
): Promise<unknown> {
	const query = async (text: ReturnType<typeof sql>) =>
		(await text.execute(db)).rows as Record<string, unknown>[];
	const relations = await query(sql`
		SELECT relname, relkind, relpersistence FROM pg_class
		WHERE relnamespace = ${schema}::regnamespace ORDER BY relname
	`);
	const columns = await query(sql`
		SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
			pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity, a.attgenerated, a.attcollation,
			row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum) AS position
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE c.relnamespace = ${schema}::regnamespace AND c.relkind = 'r'
			AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY c.relname, a.attnum
	`);
	const constraints = await query(sql`
		SELECT conrelid::regclass::text AS rel, conname, contype, condeferrable, convalidated,
			pg_get_constraintdef(oid) AS def
		FROM pg_constraint WHERE connamespace = ${schema}::regnamespace
		ORDER BY 1, 2
	`);
	const indexes = await query(sql`
		SELECT c.relname, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		WHERE c.relnamespace = ${schema}::regnamespace ORDER BY c.relname
	`);
	const triggers = await query(sql`
		SELECT t.tgname, c.relname, t.tgenabled, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		WHERE c.relnamespace = ${schema}::regnamespace AND NOT t.tgisinternal
		ORDER BY t.tgname
	`);
	const functions = await query(sql`
		SELECT proname, pg_get_functiondef(oid) AS def FROM pg_proc
		WHERE pronamespace = ${schema}::regnamespace ORDER BY proname
	`);
	const unqualifyAll = (rows: Record<string, unknown>[]) =>
		rows.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, value]) => [
					key,
					typeof value === "string" ? unqualify(value, schema) : value,
				]),
			),
		);
	const data: Record<string, unknown> = {};
	for (const relation of relations) {
		if (relation.relkind !== "r") continue;
		const table = String(relation.relname);
		data[table] = await describeRows(db, table, window);
	}
	return {
		relations,
		columns: unqualifyAll(columns),
		constraints: unqualifyAll(constraints),
		indexes: unqualifyAll(indexes),
		triggers: unqualifyAll(triggers),
		functions: unqualifyAll(functions),
		data,
	};
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

async function describeRows(
	db: Kysely<Database>,
	table: string,
	window: BuildWindow,
): Promise<unknown> {
	const { rows } = await sql<Record<string, unknown>>`
		SELECT * FROM ${sql.raw(ident(table))}
	`.execute(db);
	if (table === "_emdash_migrations") {
		for (const row of rows) {
			if (!ISO_MILLIS.test(String(row.timestamp))) {
				throw new Error(`Migration ${String(row.name)} has timestamp ${String(row.timestamp)}`);
			}
		}
		return rows.map((row) => String(row.name)).toSorted();
	}
	return sortedRows(rows, window);
}

export function describeSchema(
	db: Kysely<Database>,
	window: BuildWindow,
	schema?: string,
): Promise<unknown> {
	return schema ? describePostgres(db, schema, window) : describeSqlite(db, window);
}

function templateLiteral(text: string): string {
	return `\`${text.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")}\``;
}

export function renderBaselineModule(
	exportName: string,
	through: string,
	statements: readonly string[],
): string {
	return [
		"// Generated by `pnpm --filter emdash migrations:baseline`. Do not edit.",
		'import type { MigrationBaseline } from "../baseline.js";',
		"",
		`export const ${exportName}: MigrationBaseline = {`,
		`\tthrough: ${JSON.stringify(through)},`,
		"\tstatements: [",
		...statements.map((statement) => `\t\t${templateLiteral(statement)},`),
		"\t],",
		"};",
		"",
	].join("\n");
}
