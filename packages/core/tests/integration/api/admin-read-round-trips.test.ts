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

import { loadAdminBootData } from "../../../src/api/admin-boot.js";
import { handleCommentCounts } from "../../../src/api/handlers/comments.js";
import { handleContentAuthors } from "../../../src/api/handlers/content.js";
import { handleDashboardStats } from "../../../src/api/handlers/dashboard.js";
import { handleMediaList } from "../../../src/api/handlers/media.js";
import { GET as getCommentCounts } from "../../../src/astro/routes/api/admin/comments/counts.js";
import { GET as getCurrentUser } from "../../../src/astro/routes/api/auth/me.js";
import { GET as getAuthMode } from "../../../src/astro/routes/api/auth/mode.js";
import { GET as getEntry } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { GET as compareEntry } from "../../../src/astro/routes/api/content/[collection]/[id]/compare.js";
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
const COMPARE_MAX_WAVES = 2;
const MANIFEST_MAX_WAVES = 1;
const MANIFEST_MAX_QUERIES = 6;
const DASHBOARD_MAX_WAVES = 2;
const DASHBOARD_MAX_QUERIES = 10;
const LIST_MAX_WAVES = 1;
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

	it("adds the slug the draft stages when asked, leaving slug the live one", async () => {
		const staged = await createTestRuntime(ctx.db).handleContentUpdate("posts", draftEntryId, {
			data: { title: "Pending title" },
			slug: "pending-slug",
		});
		if (!staged.success) throw new Error(staged.error.message);
		await runDeferred();
		const params = { collection: "posts", id: draftEntryId };

		const asked = await inRequest(() =>
			getEntry(context(`/content/posts/${draftEntryId}?draftSlug=1`, params)),
		);
		const plain = await inRequest(() =>
			getEntry(context(`/content/posts/${draftEntryId}`, params)),
		);

		expect(asked.response.status, asked.text).toBe(200);
		const { item } = JSON.parse(asked.text).data;
		expect(item).toMatchObject({ slug: "post-3", draftSlug: "pending-slug" });
		expect(item.data.title).toBe("Pending title");
		expect(sequentialWaves(asked.spans)).toBeLessThanOrEqual(ENTRY_MAX_WAVES);
		expect(asked.spans.length).toBeLessThanOrEqual(ENTRY_MAX_QUERIES);
		const plainItem = JSON.parse(plain.text).data.item;
		expect(plainItem.slug).toBe("post-3");
		expect(plainItem).not.toHaveProperty("draftSlug");
	});

	it("compares an entry's draft with its live version within the round-trip budget", async () => {
		const params = { collection: "posts", id: draftEntryId };
		const result = await inRequest(() =>
			compareEntry(context(`/content/posts/${draftEntryId}/compare`, params)),
		);

		expect(result.response.status, result.text).toBe(200);
		const { data } = JSON.parse(result.text);
		expect(data.hasChanges).toBe(true);
		expect(data.live.title).toBe("Post 3");
		expect(data.draft.title).toBe("Pending title");
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(COMPARE_MAX_WAVES);
		const listed = await handlers.handleRevisionList("posts", draftEntryId);
		if (!listed.success) throw new Error(listed.error.message);
		const listedDraft = listed.data.items.find((item) => item.id === data.revisions.draft.id);
		expect(listedDraft?.fingerprint).toBe(data.revisions.draft.fingerprint);
		expect(data.revisions.live.fingerprint).not.toBe(data.revisions.draft.fingerprint);
	});

	it("builds the manifest within the round-trip budget", async () => {
		const result = await inRequest(() => getManifest(context("/manifest", {})));

		expect(result.response.status, result.text).toBe(200);
		expect(Object.keys(JSON.parse(result.text).data.collections)).toEqual(["pages", "posts"]);
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(MANIFEST_MAX_WAVES);
		expect(result.spans.length).toBeLessThanOrEqual(MANIFEST_MAX_QUERIES);
	});

	it("embeds in the admin page what the manifest and auth/me routes return", async () => {
		const sessionUser = {
			...user,
			email: "editor@example.com",
			name: "Editor",
			avatarUrl: null,
			emailVerified: true,
			disabled: false,
			data: { welcomeDismissed: true },
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const locals = { emdash: handlers, user: sessionUser } as unknown as APIContext["locals"];
		const routeContext = (path: string) =>
			({ ...context(path, {}), locals }) as unknown as APIContext;

		const manifest = await inRequest(() => getManifest(routeContext("/manifest")));
		const me = await inRequest(() => getCurrentUser(routeContext("/auth/me")));
		const counts = await inRequest(() => getCommentCounts(routeContext("/admin/comments/counts")));
		spans.spans = [];
		const embedded = await runWithContext({ editMode: false }, () =>
			loadAdminBootData(locals, "/"),
		);

		expect(embedded).toEqual({
			manifest: JSON.parse(manifest.text).data,
			currentUser: JSON.parse(me.text).data,
			commentCounts: JSON.parse(counts.text).data,
		});
		expect(sequentialWaves(spans.spans)).toBeLessThanOrEqual(MANIFEST_MAX_WAVES);
		// The comment counts are one statement beside the manifest's reads.
		expect(spans.spans.length).toBeLessThanOrEqual(MANIFEST_MAX_QUERIES + 1);
	});

	it("embeds in a signed-out login page what the auth/mode route returns, in its one query", async () => {
		await ctx.db
			.insertInto("allowed_domains")
			.values({ domain: "example.com", default_role: Role.AUTHOR, enabled: 1 })
			.execute();
		const signedOut = { emdash: handlers } as unknown as APIContext["locals"];
		const mode = await inRequest(() =>
			getAuthMode({ ...context("/auth/mode", {}), locals: signedOut } as unknown as APIContext),
		);
		spans.spans = [];
		const embedded = await runWithContext({ editMode: false }, () =>
			loadAdminBootData(signedOut, "/login"),
		);

		expect(embedded).toEqual({ authMode: JSON.parse(mode.text).data });
		expect(embedded).toMatchObject({ authMode: { signupEnabled: true } });
		expect(spans.spans.length).toBe(mode.spans.length);
		expect(spans.spans.length).toBe(1);
	});

	it("embeds no comment counts for users who can't moderate comments", async () => {
		const author = {
			id: "user_author",
			role: Role.AUTHOR,
			email: "author@example.com",
			name: "Author",
			avatarUrl: null,
			emailVerified: true,
			disabled: false,
			data: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const embedded = await runWithContext({ editMode: false }, () =>
			loadAdminBootData({ emdash: handlers, user: author }, "/"),
		);

		expect(embedded).not.toBeNull();
		expect(embedded).not.toHaveProperty("commentCounts");
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

	it("counts the trash with the list for callers who can read it", async () => {
		const trashed = await handlers.handleContentDelete("posts", draftEntryId);
		if (!trashed.success) throw new Error(trashed.error.message);

		const result = await inRequest(() =>
			listEntries(context("/content/posts?limit=20&trashTotal=1", { collection: "posts" })),
		);
		expect(result.response.status, result.text).toBe(200);
		const { items, total, trashTotal } = JSON.parse(result.text).data;
		expect(items).toHaveLength(2);
		expect(total).toBe(2);
		expect(trashTotal).toBe(1);
		expect(sequentialWaves(result.spans)).toBeLessThanOrEqual(LIST_MAX_WAVES);

		const subscriberList = await inRequest(() =>
			listEntries({
				...context("/content/posts?limit=20&trashTotal=1", { collection: "posts" }),
				locals: { emdash: handlers, user: { id: "user_subscriber", role: Role.SUBSCRIBER } },
			} as unknown as APIContext),
		);
		expect(subscriberList.response.status, subscriberList.text).toBe(200);
		expect(JSON.parse(subscriberList.text).data).not.toHaveProperty("trashTotal");

		const plain = await inRequest(() =>
			listEntries(context("/content/posts?limit=20", { collection: "posts" })),
		);
		expect(JSON.parse(plain.text).data).not.toHaveProperty("trashTotal");
	});

	it("lists a collection's authors in one round trip", async () => {
		spans.spans = [];
		const result = await runWithContext({ editMode: false }, () =>
			handleContentAuthors(handlers.db, "posts"),
		);

		if (!result.success) throw new Error(result.error.message);
		expect(result.data.items).toEqual([
			{ id: user.id, name: "Editor", email: "editor@example.com", avatarUrl: null },
		]);
		expect(sequentialWaves(spans.spans)).toBe(1);
		expect(spans.spans).toHaveLength(1);
	});

	it("counts comments by status in one query", async () => {
		spans.spans = [];
		const result = await handleCommentCounts(handlers.db);

		if (!result.success) throw new Error(result.error.message);
		expect(result.data).toEqual({ pending: 0, approved: 0, spam: 0, trash: 0 });
		expect(spans.spans).toHaveLength(1);
	});

	it("reads a numbered media page in one round trip", async () => {
		spans.spans = [];
		const result = await handleMediaList(handlers.db, { page: 1, limit: 35, folderId: null });

		if (!result.success) throw new Error(result.error.message);
		expect(result.data.items).toEqual([]);
		expect(sequentialWaves(spans.spans)).toBe(1);
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
