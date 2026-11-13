/**
 * Sequential database round trips for an editor's autosave and publish.
 *
 * Each round trip is paid in full on a remote database (Hyperdrive, D1), so
 * these numbers bound how long a save takes there. Media usage bookkeeping is
 * deferred past the response and must not count against it.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const deferred = vi.hoisted(() => ({ tasks: [] as Array<() => void | Promise<void>> }));
vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.tasks.push(fn);
	},
}));

import { PUT as updateContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { POST as publishContent } from "../../../src/astro/routes/api/content/[collection]/[id]/publish.js";
import {
	activateMediaUsageCapture,
	continueMediaUsageActivation,
} from "../../../src/media/usage/activation.js";
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

const AUTOSAVE_MAX_WAVES = 10;
const PUBLISH_MAX_WAVES = 9;

const touchesMediaUsage = (span: QuerySpan) =>
	span.tables.some((table) => table.startsWith("_emdash_media_usage"));

describeEachDialect("content write round trips", (dialect) => {
	let ctx: DialectTestContext;
	let spans: QuerySpans;
	let handlers: ReturnType<typeof handlersFromRuntime>;
	let entryId: string;
	const user = { id: "user_editor", role: Role.EDITOR as RoleLevel };

	beforeEach(async () => {
		deferred.tasks = [];
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			supports: ["drafts", "revisions", "preview", "search", "seo"],
		});
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", { slug: "featured_image", label: "Image", type: "image" });
		await registry.createField("posts", { slug: "content", label: "Body", type: "portableText" });
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
		let activation = await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		while (activation.outcome === "activating") {
			activation = await continueMediaUsageActivation(ctx.db);
		}
		expect(activation.outcome).toBe("active");

		const setupRuntime = createTestRuntime(ctx.db);
		const created = await setupRuntime.handleContentCreate("posts", {
			data: { title: "Draft" },
			slug: "draft",
			authorId: user.id,
		});
		if (!created.success) throw new Error(created.error.message);
		entryId = created.data.item.id;
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
	): Promise<{ status: number; body: string; spans: QuerySpan[] }> {
		spans.spans = [];
		const response = await runWithContext({ editMode: false }, run);
		return { status: response.status, body: await response.text(), spans: spans.spans };
	}

	function context(method: string, path: string, body: unknown) {
		const url = `http://localhost/_emdash/api/content/posts/${entryId}${path}`;
		return {
			params: { collection: "posts", id: entryId },
			url: new URL(url),
			request: new Request(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			locals: { emdash: handlers, user },
			cache: { enabled: false, invalidate: vi.fn() },
		} as unknown as Parameters<typeof updateContent>[0];
	}

	const autosave = (title: string) =>
		inRequest(() => updateContent(context("PUT", "", { data: { title }, skipRevision: true })));

	it("autosaves a new draft within the round-trip budget and refreshes usage afterwards", async () => {
		const response = await autosave("First autosave");

		expect(response.status, response.body).toBe(200);
		expect(sequentialWaves(response.spans)).toBeLessThanOrEqual(AUTOSAVE_MAX_WAVES);
		expect(response.spans.filter(touchesMediaUsage)).toEqual([]);

		spans.spans = [];
		await runDeferred();
		expect(spans.spans.some(touchesMediaUsage)).toBe(true);
	});

	it("autosaves over an existing draft within the round-trip budget", async () => {
		await autosave("First autosave");
		await runDeferred();

		const response = await autosave("Second autosave");

		expect(response.status, response.body).toBe(200);
		expect(JSON.parse(response.body).data.item.data.title).toBe("Second autosave");
		expect(sequentialWaves(response.spans)).toBeLessThanOrEqual(AUTOSAVE_MAX_WAVES);
	});

	it("publishes a draft within the round-trip budget and refreshes usage afterwards", async () => {
		await autosave("Ready to publish");
		await runDeferred();

		const response = await inRequest(() => publishContent(context("POST", "/publish", {})));

		expect(response.status, response.body).toBe(200);
		expect(JSON.parse(response.body).data.item).toEqual(
			expect.objectContaining({ status: "published", draftRevisionId: null }),
		);
		expect(sequentialWaves(response.spans)).toBeLessThanOrEqual(PUBLISH_MAX_WAVES);
		expect(response.spans.filter(touchesMediaUsage)).toEqual([]);

		spans.spans = [];
		await runDeferred();
		expect(spans.spans.some(touchesMediaUsage)).toBe(true);
	});
});
