import type { Kysely, KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/loader.js", () => ({ getDb: vi.fn() }));
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

import { resetLayoutPrefetchForTests, startLayoutPrefetch } from "../../../src/astro/prefetch.js";
import type { Database } from "../../../src/database/types.js";
import { getDb } from "../../../src/loader.js";
import { getMenu } from "../../../src/menus/index.js";
import { runWithContext, type EmDashRequestContext } from "../../../src/request-context.js";
import { getSiteSettings, invalidateSiteSettingsSnapshot } from "../../../src/settings/index.js";
import {
	getTaxonomyTerms,
	invalidateTermCache,
	resetTaxonomyDefsCacheForTests,
} from "../../../src/taxonomies/index.js";
import { getWidgetArea } from "../../../src/widgets/index.js";
import { renderWithLayoutPrefetch } from "../../utils/layout-prefetch.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let queries: string[] = [];

const home = async () => {
	await getSiteSettings();
	await getMenu("primary");
	await getTaxonomyTerms("tag", { includeCounts: false });
};

const about = async () => {
	await getSiteSettings();
};

const sidebarPage = async () => {
	await getSiteSettings();
	await getWidgetArea("sidebar");
};

async function queriesOf(render: () => Promise<unknown>, route?: string): Promise<string[]> {
	queries = [];
	if (route) await renderWithLayoutPrefetch(route, render);
	else await runWithContext({ editMode: false }, render);
	return queries.toSorted();
}

describe("learned layout prefetch", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("_emdash_menus")
			.values({ id: "m1", name: "primary", label: "Primary" })
			.execute();
		await db
			.insertInto("_emdash_menus")
			.values({ id: "m2", name: "footer", label: "Footer" })
			.execute();
		await db
			.insertInto("_emdash_widget_areas")
			.values({ id: "sidebar", name: "sidebar", label: "Sidebar" })
			.execute();
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				queries.push(db.getExecutor().compileQuery(args.node, args.queryId).sql);
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		};
		vi.mocked(getDb).mockResolvedValue(db.withPlugin(plugin));
		resetLayoutPrefetchForTests();
		resetTaxonomyDefsCacheForTests();
		invalidateTermCache();
		invalidateSiteSettingsSnapshot();
		// Warm the isolate caches so every render below reads the same.
		await runWithContext({ editMode: false }, async () => {
			await home();
			await sidebarPage();
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.clearAllMocks();
	});

	it("starts the reads a route made before its next render, and nothing else", async () => {
		const baseline = await queriesOf(home);
		expect(baseline.length).toBeGreaterThan(0);
		await queriesOf(about, "/about");

		expect(await queriesOf(home, "/")).toEqual(baseline);

		queries = [];
		const ctx: EmDashRequestContext = { editMode: false };
		await runWithContext(ctx, async () => {
			const prefetch = startLayoutPrefetch(ctx, "/");
			await prefetch.settled;
			expect(queries.toSorted()).toEqual(baseline);
			await home();
		});
		expect(queries.toSorted()).toEqual(baseline);
	});

	it("never starts menus or term lists the route did not read", async () => {
		const baseline = await queriesOf(about);
		await queriesOf(about, "/about");

		expect(await queriesOf(about, "/about")).toEqual(baseline);
		expect(baseline.some((sql) => sql.includes("_emdash_menus"))).toBe(false);
	});

	it("stops starting a read once a render of the route did not use it", async () => {
		const homeBaseline = await queriesOf(home);
		const aboutBaseline = await queriesOf(about);
		await queriesOf(home, "/page/[slug]");
		await queriesOf(about, "/page/[slug]");

		expect(await queriesOf(about, "/page/[slug]")).toEqual(aboutBaseline);
		expect(await queriesOf(home, "/page/[slug]")).toEqual(homeBaseline);
	});

	it("seeds a new route with the reads every render so far has made", async () => {
		const sidebarBaseline = await queriesOf(sidebarPage);
		expect(sidebarBaseline.some((sql) => sql.includes("_emdash_widget"))).toBe(true);
		await queriesOf(sidebarPage, "/");

		queries = [];
		const ctx: EmDashRequestContext = { editMode: false };
		await runWithContext(ctx, () => startLayoutPrefetch(ctx, "/sidebar").settled);
		expect(queries.toSorted()).toEqual(sidebarBaseline);

		expect(await queriesOf(sidebarPage, "/sidebar")).toEqual(sidebarBaseline);
	});
});
