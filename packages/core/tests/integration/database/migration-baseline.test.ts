import { writeFileSync } from "node:fs";

import { Kysely } from "kysely";
import { afterEach, expect, it } from "vitest";

import { MIGRATION_LOCK_TABLE } from "../../../src/database/migration-lock.js";
import {
	applyMigrationBaseline,
	loadMigrationBaseline,
} from "../../../src/database/migrations/baseline.js";
import {
	createMigrator,
	MIGRATION_NAMES,
	runMigrations,
} from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { NodeSqliteDialect, openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import {
	describeSchema,
	generatePostgresBaseline,
	generateSqliteBaseline,
	renderBaselineModule,
} from "../../utils/migration-baseline.js";
import {
	createForDialect,
	createTestPostgresDatabase,
	describeEachDialect,
	type DialectTestContext,
	teardownForDialect,
	teardownTestPostgresDatabase,
} from "../../utils/test-db.js";

const UPDATE = process.env.EMDASH_UPDATE_MIGRATION_BASELINE === "1";
const REGENERATE =
	"Regenerate both baselines with `EMDASH_TEST_PG=<connection string> pnpm --filter emdash migrations:baseline`.";
const LATEST = MIGRATION_NAMES.at(-1) ?? "";

// Each case runs every migration, which takes seconds on Postgres.
const MIGRATING = { timeout: 60_000 };

describeEachDialect("migration baseline", (dialect) => {
	const contexts: DialectTestContext[] = [];

	afterEach(async () => {
		for (const ctx of contexts.splice(0)) await teardownForDialect(ctx);
	});

	async function fresh(): Promise<DialectTestContext> {
		const ctx = await createForDialect(dialect);
		contexts.push(ctx);
		return ctx;
	}

	async function migrateOneByOne(ctx: DialectTestContext): Promise<void> {
		const migrator = createMigrator(ctx.db, { migrationTableSchema: ctx.pgCtx?.schemaName });
		const { error } = await migrator.migrateToLatest();
		if (error) throw error;
	}

	it.runIf(UPDATE)("regenerates the baseline", MIGRATING, async () => {
		const ctx = await fresh();
		const start = new Date();
		await migrateOneByOne(ctx);
		const window = { start, end: new Date() };
		const statements = ctx.pgCtx
			? await generatePostgresBaseline(ctx.db, ctx.pgCtx.schemaName, window)
			: await generateSqliteBaseline(ctx.db, window);
		writeFileSync(
			new URL(`../../../src/database/migrations/baseline/${dialect}.ts`, import.meta.url),
			renderBaselineModule(`${dialect.toUpperCase()}_BASELINE`, LATEST, statements),
		);
	});

	it("covers every registered migration", async () => {
		const baseline = await loadMigrationBaseline(dialect === "postgres");
		expect(
			baseline.through,
			`The ${dialect} migration baseline is out of date. ${REGENERATE}`,
		).toBe(LATEST);
	});

	it("builds the same schema and rows as running every migration", MIGRATING, async () => {
		const start = new Date();
		const migrated = await fresh();
		await migrateOneByOne(migrated);

		const squashed = await fresh();
		const covered = await applyMigrationBaseline(squashed.db, MIGRATION_NAMES, {
			migrationTable: "_emdash_migrations",
			lockTable: MIGRATION_LOCK_TABLE,
			schema: squashed.pgCtx?.schemaName,
		});
		expect(covered, "the baseline did not apply").not.toBeNull();
		await migrateOneByOne(squashed);
		const window = { start, end: new Date() };

		expect(
			await describeSchema(squashed.db, window, squashed.pgCtx?.schemaName),
			`The ${dialect} migration baseline no longer matches the migrations. ${REGENERATE}`,
		).toEqual(await describeSchema(migrated.db, window, migrated.pgCtx?.schemaName));
	});

	it("leaves a database that already has the tables to the migrations", MIGRATING, async () => {
		const ctx = await fresh();
		await migrateOneByOne(ctx);
		const migrations = ctx.db.selectFrom("_emdash_migrations");
		await ctx.db.deleteFrom("_emdash_migrations").execute();

		const covered = await applyMigrationBaseline(ctx.db, MIGRATION_NAMES, {
			migrationTable: "_emdash_migrations",
			lockTable: MIGRATION_LOCK_TABLE,
			schema: ctx.pgCtx?.schemaName,
		});

		expect(covered).toBeNull();
		const { count } = await migrations
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(Number(count)).toBe(0);
	});
});

it("migrates a fresh node:sqlite database in one call", async () => {
	const statements: string[] = [];
	const db = new Kysely<Database>({
		dialect: new NodeSqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
		log: (event) => statements.push(event.query.sql),
	});
	try {
		const { applied } = await runMigrations(db);

		expect(applied).toEqual([...MIGRATION_NAMES]);
		// Only the applied-count read goes through the query executor; the
		// baseline runs as one script.
		expect(statements).toHaveLength(1);
		expect(await runMigrations(db)).toEqual({ applied: [] });
	} finally {
		await db.destroy();
	}
});

it.runIf(process.env.EMDASH_TEST_PG)(
	"migrates a fresh Postgres database in two queries",
	MIGRATING,
	async () => {
		const queries: string[] = [];
		const ctx = await createTestPostgresDatabase({
			log: (event) => queries.push(event.query.sql),
		});
		try {
			const { applied } = await runMigrations(ctx.db);

			expect(applied).toEqual([...MIGRATION_NAMES]);
			expect(queries).toHaveLength(2);
			expect(await runMigrations(ctx.db)).toEqual({ applied: [] });
		} finally {
			await teardownTestPostgresDatabase(ctx);
		}
	},
);
