import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));

import { onRequest as setupMiddleware } from "../../../src/astro/middleware/setup.js";
import { POST as devReset } from "../../../src/astro/routes/api/setup/dev-reset.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { QuerySpans } from "../../utils/query-spans.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type MiddlewareContext = Parameters<typeof setupMiddleware>[0];

describeEachDialect("setup middleware", (dialect) => {
	let ctx: DialectTestContext;
	let spans: QuerySpans;
	let config: Record<string, unknown>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		spans = new QuerySpans();
		config = {};
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function completeSetup(): Promise<void> {
		await new OptionsRepository(ctx.db).set("emdash:setup_complete", true);
	}

	async function addUser(): Promise<void> {
		await ctx.db
			.insertInto("users")
			.values({ id: "admin", email: "admin@example.com", name: "Admin", role: 50 })
			.execute();
	}

	async function visit(path = "/_emdash/admin/content/posts") {
		spans.spans = [];
		const next = vi.fn(async () => new Response("admin"));
		const context = {
			url: new URL(`http://localhost${path}`),
			locals: { emdash: { db: ctx.db.withPlugin(spans), config } },
			redirect: (location: string) =>
				new Response(null, { status: 302, headers: { Location: location } }),
		} as unknown as MiddlewareContext;
		const response = (await setupMiddleware(context, next)) as Response;
		return {
			redirectedTo: response.headers.get("Location"),
			reachedAdmin: next.mock.calls.length === 1,
			queries: spans.spans.length,
		};
	}

	it("sends an unfinished site to the setup wizard", async () => {
		expect(await visit()).toEqual({
			redirectedTo: "/_emdash/admin/setup",
			reachedAdmin: false,
			queries: 1,
		});
	});

	it("sends a passkey site with the flag set but no users to the setup wizard", async () => {
		await completeSetup();

		expect((await visit()).redirectedTo).toBe("/_emdash/admin/setup");
		expect((await visit()).redirectedTo).toBe("/_emdash/admin/setup");
	});

	it("lets an external-auth site through before its first user signs in", async () => {
		config = { auth: { type: "cloudflare-access", entrypoint: "x", config: {} } };
		await completeSetup();

		expect(await visit()).toEqual({ redirectedTo: null, reachedAdmin: true, queries: 1 });
	});

	it("checks a set-up site once, then lets later requests through without a query", async () => {
		await completeSetup();
		await addUser();

		expect(await visit()).toEqual({ redirectedTo: null, reachedAdmin: true, queries: 1 });
		expect(await visit("/_emdash/admin/")).toEqual({
			redirectedTo: null,
			reachedAdmin: true,
			queries: 0,
		});
	});

	it("checks again after the dev reset", async () => {
		await completeSetup();
		await addUser();
		await visit();

		const reset = await devReset({
			locals: { emdash: { db: ctx.db, config } },
		} as unknown as APIContext);
		expect(reset.status).toBe(200);

		expect(await visit()).toEqual({
			redirectedTo: "/_emdash/admin/setup",
			reachedAdmin: false,
			queries: 1,
		});
	});

	it("never checks the setup wizard itself", async () => {
		expect(await visit("/_emdash/admin/setup")).toEqual({
			redirectedTo: null,
			reachedAdmin: true,
			queries: 0,
		});
	});
});
