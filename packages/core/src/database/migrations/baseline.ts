import { type CompiledQuery, type Kysely, sql } from "kysely";
import { MIGRATION_LOCK_ID } from "kysely/migration";

import {
	executeAtomicBatchIfSupported,
	isPostgres,
	supportsAtomicBatch,
} from "../dialect-helpers.js";
import { KYSELY_PG_MIGRATION_LOCK_ID, MIGRATION_LOCK_BUSY_MESSAGE } from "../pg-migration-lock.js";
import type { Database } from "../types.js";

/**
 * A squashed schema: the statements that build, on an empty database, what
 * running every migration up to and including `through` builds, apart from the
 * migration bookkeeping tables.
 *
 * The files under `baseline/` are generated from a database that ran every
 * migration; see `tests/integration/database/migration-baseline.test.ts`.
 */
export interface MigrationBaseline {
	readonly through: string;
	readonly statements: readonly string[];
}

export interface MigrationBookkeepingTables {
	migrationTable: string;
	lockTable: string;
	schema?: string;
}

export async function loadMigrationBaseline(postgres: boolean): Promise<MigrationBaseline> {
	return postgres
		? (await import("./baseline/postgres.js")).POSTGRES_BASELINE
		: (await import("./baseline/sqlite.js")).SQLITE_BASELINE;
}

/**
 * Build an empty database's schema from the squashed baseline and record the
 * migrations it covers as applied.
 *
 * The attempt is atomic: one D1 batch, one multi-statement Postgres query
 * (an implicit transaction that takes the migration advisory lock first), or
 * one synchronous SQLite transaction. Every statement is a plain CREATE or
 * INSERT, so a database that already holds any of the objects rolls the whole
 * attempt back: another instance that got there first, an earlier attempt
 * whose response was lost, or unrelated tables with the same names.
 *
 * Returns the covered migration names, or null when nothing was applied and
 * the migrations must run one by one. That includes every database that can
 * run the statements only one round trip at a time, such as D1 over the REST
 * API or SQLite through another driver.
 */
export async function applyMigrationBaseline(
	db: Kysely<Database>,
	migrationNames: readonly string[],
	tables: MigrationBookkeepingTables,
): Promise<string[] | null> {
	const adapter: object = db.getExecutor().adapter;
	const atomicBatch = supportsAtomicBatch(db);
	const postgres = isPostgres(db);
	const scriptAdapter = isScriptAdapter(adapter) ? adapter : null;
	if (!atomicBatch && !postgres && !scriptAdapter) return null;

	const baseline = await loadMigrationBaseline(postgres);
	const end = migrationNames.indexOf(baseline.through);
	if (end === -1) return null;
	const covered = migrationNames.slice(0, end + 1);

	const queries = [
		...baseline.statements.map((statement) => sql.raw(statement).compile(db)),
		...bookkeepingQueries(db, covered, tables),
	];
	try {
		if (atomicBatch) {
			await executeAtomicBatchIfSupported(
				db,
				queries.map((query) => ({ compile: () => query })),
			);
		} else if (postgres) {
			await sql.raw(script([POSTGRES_LOCK, ...queries])).execute(db);
		} else {
			await scriptAdapter?.executeScript(script(queries));
		}
	} catch {
		return null;
	}
	return covered;
}

/**
 * Declared by an adapter that runs a multi-statement script as one
 * transaction, in one call (node:sqlite).
 */
interface ScriptAdapter {
	executeScript(script: string): void | Promise<void>;
}

function isScriptAdapter(adapter: object): adapter is ScriptAdapter {
	return "executeScript" in adapter && typeof adapter.executeScript === "function";
}

/** The tables and rows Kysely's Migrator creates, as it creates them. */
function bookkeepingQueries(
	db: Kysely<Database>,
	covered: readonly string[],
	{ migrationTable, lockTable, schema }: MigrationBookkeepingTables,
): CompiledQuery[] {
	const builder = schema ? db.schema.withSchema(schema) : db.schema;
	const table = (name: string) => sql.table(schema ? `${schema}.${name}` : name);
	const timestamp = new Date().toISOString();
	return [
		builder
			.createTable(migrationTable)
			.addColumn("name", "varchar(255)", (col) => col.notNull().primaryKey())
			.addColumn("timestamp", "varchar(255)", (col) => col.notNull())
			.compile(),
		builder
			.createTable(lockTable)
			.addColumn("id", "varchar(255)", (col) => col.notNull().primaryKey())
			.addColumn("is_locked", "integer", (col) => col.notNull().defaultTo(0))
			.compile(),
		sql`INSERT INTO ${table(lockTable)} (${sql.ref("id")}, ${sql.ref("is_locked")}) VALUES (${sql.lit(MIGRATION_LOCK_ID)}, ${sql.lit(0)})`.compile(
			db,
		),
		sql`INSERT INTO ${table(migrationTable)} (${sql.ref("name")}, ${sql.ref("timestamp")}) VALUES ${sql.join(
			covered.map((name) => sql`(${sql.lit(name)}, ${sql.lit(timestamp)})`),
		)}`.compile(db),
	];
}

/**
 * The first statement of the Postgres script. Postgres runs a multi-statement
 * simple-protocol query as a single implicit transaction, so the advisory lock
 * is held until it commits and any failure rolls back every statement.
 */
const POSTGRES_LOCK = `DO $emdash$ BEGIN IF NOT pg_try_advisory_xact_lock(${KYSELY_PG_MIGRATION_LOCK_ID}) THEN RAISE EXCEPTION '${MIGRATION_LOCK_BUSY_MESSAGE}'; END IF; END $emdash$`;

function script(statements: readonly (CompiledQuery | string)[]): string {
	return statements
		.map((statement) => {
			if (typeof statement === "string") return statement;
			if (statement.parameters.length > 0) {
				throw new Error("Baseline statements must not take parameters");
			}
			return statement.sql;
		})
		.join(";\n");
}
