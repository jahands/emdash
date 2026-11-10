/**
 * A save through the content route reuses what authorizing it read, and still
 * refuses to overwrite a write that lands in between.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PUT as updateContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createRequestMetrics, runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { recordQueries, type QueryRecorder } from "../../utils/query-recorder.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = { id: "user-editor", role: Role.EDITOR };

const ENTRY_ROW_READ = /^select \* from "ec_posts" where id = /i;
const REVISION_READ = /^select \* from "revisions" where "id" = /i;
const COLLECTION_READ = /^select \* from "_emdash_collections" where "slug" = /i;

describeEachDialect("content save round trips", (dialect) => {
	let ctx: DialectTestContext;
	let recorder: QueryRecorder;
	let runtime: EmDashRuntime;
	let id: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			supports: ["drafts", "revisions", "seo"],
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		const created = await createTestRuntime(ctx.db).handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "live",
		});
		if (!created.success) throw new Error(created.error.message);
		id = created.data.item.id;
		await createTestRuntime(ctx.db).handleContentPublish("posts", id);
		recorder = recordQueries(ctx.db);
		runtime = createTestRuntime(recorder.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function put(
		body: Record<string, unknown>,
		emdash: EmDashHandlers = handlersFromRuntime(runtime),
	) {
		const url = `http://localhost/_emdash/api/content/posts/${id}`;
		const response = await runWithContext(
			{ editMode: false, metrics: createRequestMetrics(performance.now()) },
			() =>
				updateContent({
					params: { collection: "posts", id },
					request: new Request(url, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
					url: new URL(url),
					locals: { emdash, user: EDITOR },
					cache: { enabled: false, invalidate: async () => {} },
				} as unknown as APIContext),
		);
		return {
			status: response.status,
			body: (await response.json()) as {
				data?: {
					item: { data: Record<string, unknown>; liveData?: Record<string, unknown> };
					_rev: string;
				};
				error?: { code: string };
			},
		};
	}

	async function currentRev() {
		const read = await createTestRuntime(ctx.db).handleContentGet("posts", id);
		if (!read.success) throw new Error(read.error.message);
		return read.data._rev;
	}

	it("reads the entry, its schema and its draft once per save", async () => {
		const first = await put({ data: { title: "Draft one" }, _rev: await currentRev() });
		expect(first.status).toBe(200);
		recorder.reset();

		const second = await put({ data: { title: "Draft two" }, _rev: first.body.data!._rev });

		expect(second.status).toBe(200);
		expect(recorder.matching(ENTRY_ROW_READ)).toHaveLength(1);
		expect(recorder.matching(REVISION_READ)).toHaveLength(1);
		expect(recorder.matching(COLLECTION_READ)).toHaveLength(1);
	});

	it("answers with the staged draft and a _rev the next save accepts", async () => {
		const first = await put({ data: { title: "Draft one" }, _rev: await currentRev() });

		expect(first.body.data!.item.data.title).toBe("Draft one");
		expect(first.body.data!.item.liveData?.title).toBe("Live");
		expect(first.body.data!._rev).toBe(await currentRev());

		const second = await put({ data: { title: "Draft two" }, _rev: first.body.data!._rev });
		expect(second.status).toBe(200);
		expect(second.body.data!.item.data.title).toBe("Draft two");
	});

	it("keeps a draft save within its round-trip budget", async () => {
		const first = await put({ data: { title: "Draft one" }, _rev: await currentRev() });
		recorder.reset();

		await put({ data: { title: "Draft two" }, _rev: first.body.data!._rev });

		expect(recorder.waves()).toBeLessThanOrEqual(SAVE_WAVE_BUDGET);
	});

	it("writes the live and draft usage projections together", async () => {
		const first = await put({ data: { title: "Draft one" }, _rev: await currentRev() });
		await ctx.db.deleteFrom("_emdash_media_usage_sources").execute();
		recorder.reset();

		const second = await put({ data: { title: "Draft two" }, _rev: first.body.data!._rev });

		expect(second.status).toBe(200);
		expect(recorder.peakConcurrency(/insert into _emdash_media_usage_generation_writes/i)).toBe(2);
		const variants = await ctx.db
			.selectFrom("_emdash_media_usage_sources")
			.select("source_variant")
			.where("content_id", "=", id)
			.orderBy("source_variant")
			.execute();
		expect(variants.map((row) => row.source_variant)).toEqual(["columns", "draft_overlay"]);
	});

	it.each([
		{
			name: "another save",
			write: async () => {
				const other = await createTestRuntime(ctx.db).handleContentUpdate("posts", id, {
					data: { title: "Other writer" },
				});
				if (!other.success) throw new Error(other.error.message);
			},
		},
		{
			name: "a write that only moves updated_at",
			write: async () => {
				await sql`UPDATE ec_posts SET updated_at = ${"2099-01-01T00:00:00.000Z"} WHERE id = ${id}`.execute(
					ctx.db,
				);
			},
		},
	])("refuses a save when $name lands after authorization", async ({ write }) => {
		const rev = await currentRev();
		const handlers = handlersFromRuntime(runtime);
		const interleaved: EmDashHandlers = {
			...handlers,
			handleContentGetForUpdate: async (...args) => {
				const result = await handlers.handleContentGetForUpdate(...args);
				await write();
				return result;
			},
		};

		const stale = await put({ data: { title: "Stale writer" }, _rev: rev }, interleaved);

		expect(stale.status).toBe(409);
		expect(stale.body.error?.code).toBe("CONFLICT");
		const after = await createTestRuntime(ctx.db).handleContentGet("posts", id);
		expect(after.data!.item.data.title).not.toBe("Stale writer");
	});

	it("still saves without a _rev when another write lands after authorization", async () => {
		const handlers = handlersFromRuntime(runtime);
		const interleaved: EmDashHandlers = {
			...handlers,
			handleContentGetForUpdate: async (...args) => {
				const result = await handlers.handleContentGetForUpdate(...args);
				await createTestRuntime(ctx.db).handleContentUpdate("posts", id, {
					data: { title: "Other writer" },
				});
				return result;
			},
		};

		const blind = await put({ data: { title: "Blind writer" } }, interleaved);

		expect(blind.status).toBe(200);
		const after = await createTestRuntime(ctx.db).handleContentGet("posts", id);
		expect(after.data!.item.data.title).toBe("Blind writer");
	});
});

const SAVE_WAVE_BUDGET = 12;
