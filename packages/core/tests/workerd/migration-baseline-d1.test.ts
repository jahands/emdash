import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { readMigrationLock } from "../../src/database/migration-lock.js";
import {
	createMigrator,
	getExactMigrationStatus,
	MIGRATION_NAMES,
	runMigrations,
} from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { describeSchema } from "../utils/migration-baseline.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
		TARGET_DB: D1Database;
	}
}

interface CountingDatabase {
	db: Kysely<Database>;
	queries: string[];
	batches: number[];
}

function connect(database: D1Database): CountingDatabase {
	const queries: string[] = [];
	const batches: number[] = [];
	const db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database }),
		log: (event) => queries.push(event.query.sql),
	});
	const adapter = db.getExecutor().adapter as unknown as {
		executeAtomicBatch(queries: readonly unknown[]): Promise<unknown>;
	};
	const executeAtomicBatch = adapter.executeAtomicBatch.bind(adapter);
	adapter.executeAtomicBatch = (statements) => {
		batches.push(statements.length);
		return executeAtomicBatch(statements);
	};
	return { db, queries, batches };
}

let squashed: CountingDatabase;
let migrated: CountingDatabase;

beforeAll(() => {
	squashed = connect(env.DB);
	migrated = connect(env.TARGET_DB);
});

beforeEach(async () => {
	await resetD1Schema(squashed.db);
	await resetD1Schema(migrated.db);
	for (const { queries, batches } of [squashed, migrated]) {
		queries.length = 0;
		batches.length = 0;
	}
});

afterAll(async () => {
	await squashed.db.destroy();
	await migrated.db.destroy();
});

describe("migration baseline on D1", () => {
	it("migrates an empty database in one query and one batch", async () => {
		const { applied } = await runMigrations(squashed.db);

		expect(applied).toEqual([...MIGRATION_NAMES]);
		expect(squashed.queries).toHaveLength(1);
		expect(squashed.batches).toHaveLength(1);
		expect((await getExactMigrationStatus(squashed.db)).pending).toEqual([]);
		expect(await readMigrationLock(squashed.db)).toBeNull();
	});

	it("builds the same schema and rows as running every migration", async () => {
		const start = new Date();
		const { error } = await createMigrator(migrated.db).migrateToLatest();
		if (error) throw error;
		await runMigrations(squashed.db);
		const window = { start, end: new Date() };

		expect(await describeSchema(squashed.db, window)).toEqual(
			await describeSchema(migrated.db, window),
		);
	});

	it("falls back to the migrations when another run created the tables first", async () => {
		const { error } = await createMigrator(squashed.db).migrateTo("004_plugins");
		if (error) throw error;
		const other = connect(env.DB);
		// The other run's migration table is not visible to this one yet.
		const { applied } = await runMigrations(other.db, { appliedCount: null });

		expect(other.batches).toHaveLength(1);
		expect(applied).toEqual(MIGRATION_NAMES.slice(MIGRATION_NAMES.indexOf("004_plugins") + 1));
		expect((await getExactMigrationStatus(squashed.db)).pending).toEqual([]);
		await other.db.destroy();
	});
});
