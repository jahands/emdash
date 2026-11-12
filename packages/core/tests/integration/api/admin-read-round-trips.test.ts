/**
 * Sequential database round trips for the admin's read paths: the entry
 * editor's GET, the manifest, the dashboard and the content list.
 *
 * Each sequential round trip is paid in full on a remote database
 * (Hyperdrive, D1). Authentication adds one more before the route runs, so
 * these budgets cover the route alone.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const deferred = vi.hoisted(() => ({ tasks: [] as Array<() => void | Promise<void>> }));
vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.tasks.push(fn);
	},
}));

import { handleDashboardStats } from "../../../src/api/handlers/dashboard.js";
import { GET as getEntry } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { GET as listEntries } from "../../../src/astro/routes/api/content/[collection]/index.js";
import { GET as getManifest } from "../../../src/astro/routes/api/manifest.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { QuerySpans, sequentialWaves, type QuerySpan } from "../../utils/query-spans.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ENTRY_MAX_WAVES = 2;
const ENTRY_MAX_QUERIES = 8;
const MANIFEST_MAX_WAVES = 1;
const MANIFEST_MAX_QUERIES = 6;
const DASHBOARD_MAX_WAVES = 2;
const DASHBOARD_MAX_QUERIES = 10;
const LIST_MAX_WAVES = 2;
const LIST_MAX_QUERIES = 6;

const body = [
	{
		_type: "block",
		_key: "a",
		style: "normal",
		children: [{ _type: "span", _key: "a0", text: "A long body the list never shows." }],
	},
];

describeEachDialect("admin read round trips", (dialect) => {
	let ctx: DialectTestContext;
	let spans: QuerySpans;
	let handlers: ReturnType<typeof handlersFromRuntime>;
	let draftEntryId: string;
	const user = { id: "user_editor", role: Role.EDITOR as RoleLevel };

	beforeEach(async () => {
		deferred.tasks = [];
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			supports: ["drafts", "revisions", "seo"],
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "string" });
		await registry.createField("posts", { slug: "content", label: "Body", type: "portableText" });
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await ctx.db
			.insertInto("users")
			.values({
				id: user.id,
				email: "editor@example.com",
				name: "Editor",
				role: user.role,
				email_verified: 1,
			})
			.execute();

		const setup = createTestRuntime(ctx.db);
		for (const n of [1, 2, 3]) {
			const created = await setup.handleContentCreate("posts", {
				data: { title: `Post ${n}`, excerpt: `Excerpt ${n}`, content: body },
				slug: `post-${n}`,
				authorId: user.id,
			});
			if (!created.success) throw new Error(created.error.message);
			draftEntryId = created.data.item.id;
		}
		const published = await setup.handleContentPublish("posts", draftEntryId);
		if (!published.success) throw new Error(published.error.message);
		const edited = await setup.handleContentUpdate("posts", draftEntryId, {
			data: { title: "Pending title" },
		});
		if (!edited.success) throw new Error(edited.error.message);
		await runDeferred();

		spans = new QuerySpans();
		handlers = handlersFromRuntime(createTestRuntime(ctx.db.withPlugin(spans)));
	});

	afterEach(async () => {
		await runDeferred();
		await teardownForDialect(ctx);
	});

	async function runDeferred(): Promise<void> {
		while (deferred.tasks.length > 0) {
			const tasks = deferred.tasks.splice(0);
			for (const task of tasks) await task();
		}
	}

	async function inRequest(
		run: () => Promise<Response>,
	): Promise<{ response: Response; text: string; spans: QuerySpan[] }> {
		spans.spans = [];
		const response = await runWithContext({ editMode: false }, run);
		return { response, text: await response.text(), spans: spans.spans };
	}

	function context(path: string, params: Record<string, string>, headers?: HeadersInit) {
		const url = new URL(`http://localhost/_emdash/api${path}`);
		return {
			params,
			url,
			request: new Request(url, { headers }),
			locals: { emdash: handlers, user },
		} as unknown as APIContext;
	}

	it("reads an entry with a pending draft within the round-trip budget", async () => {
		const result = await inRequest(() =>
			getEntry(
				context(`/content/posts/${draftEntryId}`, { collection: "posts", id: draftEntryId }),
			),
		);

		expect(result.response.status, result.text).toBe(200);
		const { item } = JSON.parse(result.text).data;
		expect(item.data.title).toBe("Pending title");
		expect(item.liveData.title).toBe("Post 3");
		expect(item.seo).toEqual(expect.objectContaining({ title: null, noIndex: false }));
		expect(item.bylines).toEqual([]);
		expect(item.references).toEqual({});
		expect(Object.keys(item).slice(-5)).toEqual([
			"bylines",
			"byline",
			"seo",
			"references",
			"liveData",
		]);
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(ENTRY_MAX_WAVES);
		expect(result.spans.length).toBeLessThanOrEqual(ENTRY_MAX_QUERIES);
	});

	it("builds the manifest within the round-trip budget", async () => {
		const result = await inRequest(() => getManifest(context("/manifest", {})));

		expect(result.response.status, result.text).toBe(200);
		expect(Object.keys(JSON.parse(result.text).data.collections)).toEqual(["pages", "posts"]);
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(MANIFEST_MAX_WAVES);
		expect(result.spans.length).toBeLessThanOrEqual(MANIFEST_MAX_QUERIES);
	});

	it("answers an unchanged manifest with 304 and a changed one in full", async () => {
		const first = await inRequest(() => getManifest(context("/manifest", {})));
		const etag = first.response.headers.get("ETag");
		expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
		expect(first.response.headers.get("Cache-Control")).toBe("private, no-cache");

		const unchanged = await inRequest(() =>
			getManifest(context("/manifest", {}, { "If-None-Match": etag! })),
		);
		expect(unchanged.response.status).toBe(304);
		expect(unchanged.text).toBe("");
		expect(unchanged.response.headers.get("ETag")).toBe(etag);

		await new SchemaRegistry(ctx.db).createField("posts", {
			slug: "subtitle",
			label: "Subtitle",
			type: "string",
		});
		const changed = await inRequest(() =>
			getManifest(context("/manifest", {}, { "If-None-Match": etag! })),
		);
		expect(changed.response.status).toBe(200);
		expect(changed.response.headers.get("ETag")).not.toBe(etag);
		expect(JSON.parse(changed.text).data.collections.posts.fields.subtitle).toBeDefined();
	});

	it("loads the dashboard within the round-trip budget", async () => {
		spans.spans = [];
		const result = await runWithContext({ editMode: false }, () =>
			handleDashboardStats(handlers.db, {
				includeDrafts: true,
				includeMediaCount: true,
				includeUserCount: true,
			}),
		);

		if (!result.success) throw new Error(result.error.message);
		expect(result.data.recentItems.map((item) => item.title)).toContain("Post 1");
		expect(result.data.collections.find((c) => c.slug === "posts")?.total).toBe(3);
		expect(sequentialWaves(spans.spans)).toBeLessThanOrEqual(DASHBOARD_MAX_WAVES);
		expect(spans.spans.length).toBeLessThanOrEqual(DASHBOARD_MAX_QUERIES);
	});

	it("lists entries with only the selected fields within the round-trip budget", async () => {
		const result = await inRequest(() =>
			listEntries(
				context("/content/posts?limit=20&fields=title,excerpt,nonexistent", {
					collection: "posts",
				}),
			),
		);

		expect(result.response.status, result.text).toBe(200);
		const { items } = JSON.parse(result.text).data;
		expect(items).toHaveLength(3);
		for (const item of items) {
			expect(Object.keys(item.data).toSorted()).toEqual(["excerpt", "title"]);
			expect(item).toEqual(
				expect.objectContaining({ id: expect.any(String), status: expect.any(String) }),
			);
			expect(item.seo).toBeDefined();
			expect(item.bylines).toBeDefined();
		}
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(LIST_MAX_WAVES);
		expect(result.spans.length).toBeLessThanOrEqual(LIST_MAX_QUERIES);
	});

	it("lists whole entries when no fields are selected", async () => {
		const result = await inRequest(() =>
			listEntries(context("/content/posts?limit=20", { collection: "posts" })),
		);

		expect(result.response.status, result.text).toBe(200);
		const { items } = JSON.parse(result.text).data;
		expect(items).toHaveLength(3);
		for (const item of items) {
			expect(item.data.content).toEqual(body);
			expect(Object.keys(item.data).toSorted()).toEqual(["content", "excerpt", "title"]);
			expect(Object.keys(item).slice(-3)).toEqual(["seo", "bylines", "byline"]);
		}
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(LIST_MAX_WAVES);
		expect(result.spans.length).toBeLessThanOrEqual(LIST_MAX_QUERIES);
	});

	it("rejects a field selection that is not a list of field slugs", async () => {
		const result = await inRequest(() =>
			listEntries(context("/content/posts?fields=title,Bad-Slug", { collection: "posts" })),
		);

		expect(result.response.status).toBe(400);
	});
});
