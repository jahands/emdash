/**
 * Content reads run independent hydration together so each costs one round
 * trip, while returning what the sequential version returned.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentGet, handleContentList } from "../../../src/api/handlers/content.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import { withTransaction } from "../../../src/database/transaction.js";
import type { Database } from "../../../src/database/types.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { recordQueries, type QueryRecorder } from "../../utils/query-recorder.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("content read round trips", (dialect) => {
	let ctx: DialectTestContext;
	let recorder: QueryRecorder;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			supports: ["drafts", "revisions", "seo"],
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		recorder = recordQueries(ctx.db);
		db = recorder.db;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPost() {
		const runtime = createTestRuntime(ctx.db);
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Published" },
			slug: "published",
		});
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.item.id;
		await new SeoRepository(ctx.db).upsert("posts", id, { title: "SEO title" });
		const byline = await new BylineRepository(ctx.db).create({
			slug: "ada",
			displayName: "Ada",
		});
		await new BylineRepository(ctx.db).setContentBylines("posts", id, [{ bylineId: byline.id }]);
		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft title" },
		});
		if (!saved.success) throw new Error(saved.error.message);
		return { id, runtime };
	}

	it("hydrates a detail read in parallel without losing data", async () => {
		const { id } = await createPost();
		const runtime = createTestRuntime(db);
		recorder.reset();

		const result = await runtime.handleContentGet("posts", id, undefined, {
			includeDrafts: true,
		});

		expect(result.success).toBe(true);
		const item = result.data!.item;
		expect(item.seo?.title).toBe("SEO title");
		expect(item.byline?.displayName).toBe("Ada");
		expect(item.data.title).toBe("Draft title");
		expect(item.liveData?.title).toBe("Published");
		expect(recorder.peakConcurrency()).toBeGreaterThanOrEqual(2);
		expect(recorder.waves()).toBeLessThan(recorder.queries().length);
	});

	it("reads the draft revision once per detail read", async () => {
		const { id } = await createPost();
		const runtime = createTestRuntime(db);
		recorder.reset();

		await runtime.handleContentGet("posts", id, undefined, { includeDrafts: true });

		expect(recorder.matching(/from "revisions" where "id"/i)).toHaveLength(1);
	});

	it("starts loading what normalizing the draft needs before reading the draft", async () => {
		const { id } = await createPost();
		const runtime = createTestRuntime(db);
		recorder.reset();

		await runWithContext({ editMode: false, metrics: createRequestMetrics(0) }, () =>
			runtime.handleContentGet("posts", id, undefined, { includeDrafts: true }),
		);

		const queries = recorder.queries();
		const datetimeFields = queries.findIndex((sql) =>
			/^select "field"\."slug", "field"\."type", "field"\."validation"/i.test(sql),
		);
		const draftRead = queries.findIndex((sql) => /from "revisions" where "id"/i.test(sql));
		expect(datetimeFields).toBeGreaterThanOrEqual(0);
		expect(datetimeFields).toBeLessThan(draftRead);
	});

	it("hydrates a list in parallel and keeps every item's data", async () => {
		const { id } = await createPost();
		recorder.reset();

		const result = await handleContentList(db, "posts", { limit: 10 });

		expect(result.success).toBe(true);
		if (!result.success) return;
		const item = result.data.items.find((entry) => entry.id === id);
		expect(item?.seo?.title).toBe("SEO title");
		expect(item?.byline?.displayName).toBe("Ada");
		expect(recorder.peakConcurrency()).toBeGreaterThanOrEqual(2);
	});

	it("runs hydration one statement at a time inside a transaction", async () => {
		const { id } = await createPost();
		await withTransaction(db, async (trx) => {
			recorder.reset();
			const result = await handleContentGet(trx, "posts", id);
			expect(result.success).toBe(true);
			if (result.success) expect(result.data.item.seo?.title).toBe("SEO title");
			expect(recorder.peakConcurrency()).toBe(1);
		});
	});
});
