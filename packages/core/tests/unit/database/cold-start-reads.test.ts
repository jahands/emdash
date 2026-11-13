import { afterAll, afterEach, beforeEach, expect, it } from "vitest";

import { readColdStartState } from "../../../src/database/cold-start-reads.js";
import { getAppliedMigrationCount } from "../../../src/database/migrations/runner.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { rowToPluginState } from "../../../src/plugins/state.js";
import { BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	createForDialect,
	describeEachDialect,
	destroySharedPool,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

afterAll(destroySharedPool);

const NAMES = [
	"site:title",
	"emdash:setup_complete",
	"emdash:exclusive_hook:email:deliver",
	"unset",
];

describeEachDialect("readColdStartState", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("returns what the separate reads return", async () => {
		const { db } = ctx;
		await new SchemaRegistry(db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await db
			.insertInto("_plugin_state")
			.values({ plugin_id: "seo", version: "1.0.0", status: "active", source: "config" })
			.execute();
		await db
			.insertInto("_plugin_state")
			.values({
				plugin_id: "gallery",
				version: "2.0.0",
				status: "inactive",
				source: "marketplace",
				marketplace_version: "2.1.0",
				mcp_tools_enabled: 1,
			})
			.execute();
		const options = new OptionsRepository(db);
		await options.set("site:title", "Hello 'world'");
		await options.set("site:seo", { googleVerification: "abc" });
		await options.set("emdash:setup_complete", true);
		await options.set("emdash:exclusive_hook:email:deliver", "smtp");
		const bylines = new BylineSchemaRegistry(db);
		await bylines.createField({ slug: "twitter", label: "Twitter", type: "url" });
		await bylines.createField({
			slug: "team",
			label: "Team",
			type: "select",
			validation: { options: ["a", "b"] },
		});

		const state = await readColdStartState(db, NAMES, "site:");

		expect(state.appliedMigrationCount).toBe(await getAppliedMigrationCount(db));
		const plugins = await db.selectFrom("_plugin_state").selectAll().execute();
		expect(
			state.pluginStates
				.map(rowToPluginState)
				.toSorted((a, b) => (a.pluginId < b.pluginId ? -1 : 1)),
		).toEqual(plugins.map(rowToPluginState).toSorted((a, b) => (a.pluginId < b.pluginId ? -1 : 1)));
		const collections = await db.selectFrom("_emdash_collections").select("slug").execute();
		expect(state.collectionSlugs.toSorted()).toEqual(collections.map((c) => c.slug).toSorted());
		expect(state.options).toEqual(await options.getMany(NAMES));
		expect(state.prefixedOptions).toEqual(await options.getVersionedByPrefix("site:"));
		expect(state.bylineFieldsVersion).toBe(await bylines.getVersion());
		expect(state.bylineFields).toEqual(await bylines.listFields());
	});

	it("reads an empty site", async () => {
		const state = await readColdStartState(ctx.db, [], "site:");

		expect(state.appliedMigrationCount).toBeGreaterThan(0);
		expect(state.options.size).toBe(0);
		expect(state.bylineFields).toEqual([]);
		expect(state.bylineFieldsVersion).toBe(0);
	});

	it("throws on a database that has not been migrated", async () => {
		const empty = await createForDialect(dialect);
		try {
			await expect(readColdStartState(empty.db, NAMES, "site:")).rejects.toThrow();
		} finally {
			await teardownForDialect(empty);
		}
	});
});
