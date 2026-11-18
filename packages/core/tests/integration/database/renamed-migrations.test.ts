import { afterEach, beforeEach, expect, it } from "vitest";

import { columnExists } from "../../../src/database/dialect-helpers.js";
import {
	createMigrator,
	MIGRATION_NAMES,
	runMigrations,
} from "../../../src/database/migrations/runner.js";
import {
	describeEachDialect,
	getExactMigrationStatusForDialect,
	runMigrationsForDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const OLD_NAMES = new Map([
	["099_content_live_list_indexes", "098_content_live_list_indexes"],
	["100_content_sitemap_indexes", "099_content_sitemap_indexes"],
]);

describeEachDialect("migrations applied under their earlier names", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		// The state a database reached on builds that numbered the index
		// migrations 098 and 099, before `098_user_last_login` existed.
		await ctx.db.schema.alterTable("users").dropColumn("last_login_at").execute();
		await ctx.db
			.updateTable("_emdash_migrations")
			.set({ timestamp: "2026-01-01T00:00:00.000Z" })
			.execute();
		await ctx.db
			.deleteFrom("_emdash_migrations")
			.where("name", "=", "098_user_last_login")
			.execute();
		for (const [current, old] of OLD_NAMES) {
			// oxlint-disable-next-line no-await-in-loop -- two rows, renamed in turn
			await ctx.db
				.updateTable("_emdash_migrations")
				.set({ name: old })
				.where("name", "=", current)
				.execute();
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("reports only the migration that never ran as pending", async () => {
		const status = await getExactMigrationStatusForDialect(ctx);

		expect(status.pending).toEqual(["098_user_last_login"]);
		expect(status.unknownApplied).toEqual([]);
	});

	it("runs the missing migration without rerunning the renamed ones", async () => {
		const { applied } = await runMigrationsForDialect(ctx);

		expect(applied).toEqual(["098_user_last_login"]);
		expect(await columnExists(ctx.db, "users", "last_login_at")).toBe(true);
		const rows = await ctx.db.selectFrom("_emdash_migrations").select("name").execute();
		expect(rows.map((row) => row.name).toSorted()).toEqual([...MIGRATION_NAMES].toSorted());
		await expect(getExactMigrationStatusForDialect(ctx)).resolves.toMatchObject({
			pending: [],
			unknownApplied: [],
		});
		expect(await runMigrationsForDialect(ctx)).toEqual({ applied: [] });
	});

	it("leaves a history that the next ordered migration run accepts", async () => {
		const options = { migrationTableSchema: ctx.pgCtx?.schemaName };
		await runMigrationsForDialect(ctx);

		// A count below the registered one sends the run through the Migrator,
		// as the next release's migration will.
		expect(await runMigrations(ctx.db, { ...options, appliedCount: 0 })).toEqual({ applied: [] });
		const { error, results } = await createMigrator(ctx.db, options).migrateToLatest();
		expect(error).toBeUndefined();
		expect(results).toEqual([]);
	});
});
