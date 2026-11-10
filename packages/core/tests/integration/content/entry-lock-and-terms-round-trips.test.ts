/**
 * Taking an edit lock and reading an entry's terms make no reads beyond the
 * ones their answers need.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import { POST as acquireLock } from "../../../src/astro/routes/api/content/[collection]/[id]/lock.js";
import { GET as getTerms } from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
import { EntryLockRepository } from "../../../src/database/repositories/entry-locks.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { recordQueries, type QueryRecorder } from "../../utils/query-recorder.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ADA = "user-ada";
const LINUS = "user-linus";

describeEachDialect("entry lock and terms round trips", (dialect) => {
	let ctx: DialectTestContext;
	let recorder: QueryRecorder;
	let entryId: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", supports: ["seo"] });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await ctx.db
			.insertInto("users")
			.values([
				{ id: ADA, email: "ada@example.com", name: "Ada", role: 40, email_verified: 1 },
				{ id: LINUS, email: "linus@example.com", name: "Linus", role: 40, email_verified: 1 },
			])
			.execute();
		const created = await createTestRuntime(ctx.db).handleContentCreate("posts", {
			data: { title: "Entry" },
			slug: "entry",
			authorId: ADA,
		});
		if (!created.success) throw new Error(created.error.message);
		entryId = created.data.item.id;
		recorder = recordQueries(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function context(path: string, method: "GET" | "POST", userId = ADA, body?: unknown) {
		const url = `http://localhost/_emdash/api/content/posts/${entryId}/${path}`;
		return {
			params: { collection: "posts", id: entryId, taxonomy: "tag" },
			request:
				method === "GET"
					? new Request(url)
					: new Request(url, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body ?? {}),
						}),
			url: new URL(url),
			locals: {
				emdash: handlersFromRuntime(createTestRuntime(recorder.db)),
				user: { id: userId, role: Role.EDITOR },
			},
		} as unknown as APIContext;
	}

	it("takes the lock with the entry row, the locking switch and one claim", async () => {
		const response = await acquireLock(context("lock", "POST", ADA, {}));

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { enabled: true, heldByCaller: true, holder: { userId: ADA, userName: "Ada" } },
		});
		expect(recorder.queries()).toHaveLength(3);
		expect(recorder.matching(/"_emdash_seo"|"users"/)).toEqual([
			expect.stringMatching(/^insert into "_emdash_entry_locks"/i),
		]);
	});

	it("names the new holder on a take-over and the current one when refused", async () => {
		await new EntryLockRepository(ctx.db).acquire({
			collection: "posts",
			entryId,
			userId: ADA,
			token: "tab-ada",
			leaseSeconds: 300,
		});

		const refused = await acquireLock(context("lock", "POST", LINUS, {}));
		expect(await refused.json()).toMatchObject({
			data: { heldByCaller: false, holder: { userId: ADA, userName: "Ada" } },
		});

		const takenOver = await acquireLock(context("lock", "POST", LINUS, { takeover: true }));
		expect(await takenOver.json()).toMatchObject({
			data: { heldByCaller: true, holder: { userId: LINUS, userName: "Linus" } },
		});
	});

	it("reads an entry's terms without resolving its translation group again", async () => {
		const taxonomies = new TaxonomyRepository(ctx.db);
		const term = await taxonomies.create({ name: "tag", slug: "news", label: "News" });
		await taxonomies.setTermsForEntry("posts", entryId, "tag", [term.id]);
		recorder.reset();

		const response = await getTerms(context("terms/tag", "GET"));

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { terms: [{ id: term.id, slug: "news" }] },
		});
		expect(recorder.matching(/translation_group/i)).toHaveLength(1);
		expect(recorder.queries()).toHaveLength(2);
	});
});
