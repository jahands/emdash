/**
 * With incremental capture active, a save answers without waiting for its
 * media usage projection. The capture trigger has already recorded the work
 * and marked coverage stale by then, and the projection catches up afterwards.
 */

import type { Kysely, KyselyPlugin, QueryId } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { installMediaUsageCaptureTriggers } from "../../../src/media/usage/capture-triggers.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

/** Holds every statement whose SQL matches `pattern` until `release()`. */
function holdStatements(db: Kysely<Database>, pattern: RegExp) {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const held = new Set<QueryId>();
	const plugin: KyselyPlugin = {
		transformQuery({ node, queryId }) {
			if (pattern.test(db.getExecutor().compileQuery(node, queryId).sql)) held.add(queryId);
			return node;
		},
		async transformResult({ queryId, result }) {
			if (held.has(queryId)) await released;
			return result;
		},
	};
	return { db: db.withPlugin(plugin), release, heldCount: () => held.size };
}

describeEachDialect("media usage after a save with capture active", (dialect) => {
	let ctx: DialectTestContext;
	let collectionId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", supports: [] });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		const collection = await registry.getCollection("posts");
		if (!collection) throw new Error("Expected posts collection");
		collectionId = collection.id;
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({
				collection_id: collectionId,
				status: "complete",
				completed_at: "2026-08-01T00:00:00.000Z",
				reconciliation_required: 0,
				capture_state: "installing",
			})
			.where("adapter_id", "=", "content-media")
			.where("scope_type", "=", "collection")
			.where("scope_key", "=", "posts")
			.execute();
		await installMediaUsageCaptureTriggers(ctx.db, { collectionId, collectionSlug: "posts" });
		await ctx.db
			.updateTable("_emdash_media_usage_index_status")
			.set({ capture_state: "active" })
			.where("collection_id", "=", collectionId)
			.execute();
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "active", activated_at: "2026-08-05T00:00:00.000Z" })
			.execute();
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		await teardownForDialect(ctx);
	});

	it("answers before processing the work its write recorded", async () => {
		const created = await createTestRuntime(ctx.db).handleContentCreate("posts", {
			data: { title: "Entry", hero: { id: "media-old", provider: "local" } },
			slug: "entry",
		});
		if (!created.success) throw new Error(created.error.message);
		await waitForDeferredTasks();
		const id = created.data.item.id;

		const hold = holdStatements(ctx.db, /^update "_emdash_media_usage_work"/i);
		const saved = await createTestRuntime(hold.db).handleContentUpdate("posts", id, {
			data: { hero: { id: "media-new", provider: "local" } },
		});

		expect(saved.success).toBe(true);
		const pending = await ctx.db
			.selectFrom("_emdash_media_usage_work")
			.select("state")
			.where("content_id", "=", id)
			.executeTakeFirst();
		expect(pending?.state).toBe("pending");
		const coverage = await ctx.db
			.selectFrom("_emdash_media_usage_index_status")
			.select("status")
			.where("collection_id", "=", collectionId)
			.executeTakeFirst();
		expect(coverage?.status).toBe("stale");

		hold.release();
		await waitForDeferredTasks();

		expect(hold.heldCount()).toBeGreaterThan(0);
		const usage = await ctx.db
			.selectFrom("_emdash_media_usage as usage")
			.innerJoin("_emdash_media_usage_sources as source", (join) =>
				join
					.onRef("source.source_key", "=", "usage.source_key")
					.onRef("source.current_generation", "=", "usage.generation"),
			)
			.select("usage.media_id")
			.where("source.content_id", "=", id)
			.execute();
		expect(usage.map((row) => row.media_id)).toEqual(["media-new"]);
	});
});
