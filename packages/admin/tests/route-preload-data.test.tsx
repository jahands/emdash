import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { AdminApp } from "../src/App.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import { createAdminRouter } from "../src/router.js";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "route-preload",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: [],
			hasSeo: false,
			fields: {},
			dateField: "publishedAt",
		},
	},
	plugins: {},
	taxonomies: [
		{ name: "category", label: "Categories", hierarchical: true, collections: [] },
		{ name: "tag", label: "Tags", hierarchical: false, collections: [] },
	],
};

const POST = {
	id: "post_1",
	type: "posts",
	slug: "hello",
	status: "published",
	locale: "en",
	translationGroup: null,
	data: { title: "Preloaded post" },
	authorId: null,
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	publishedAt: "2026-01-01T00:00:00.000Z",
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
};

const RESPONSES: Array<[path: string, data: unknown]> = [
	["/_emdash/api/content/posts/post_1/lock", { enabled: false, holder: null, heldByCaller: false }],
	["/_emdash/api/content/posts/post_1?", { item: POST }],
	["/_emdash/api/admin/bylines?", { items: [] }],
	["/_emdash/api/dashboard", { collections: [], mediaCount: 0, userCount: 0, recentItems: [] }],
	["/_emdash/api/widget-areas", { items: [{ id: "area_1", name: "main", label: "Main sidebar" }] }],
	["/_emdash/api/widget-components", { items: [] }],
	["/_emdash/api/content/posts/authors", { items: [] }],
	["/_emdash/api/content/posts?", { items: [POST], total: 1, trashTotal: 0 }],
	[
		"/_emdash/api/taxonomies/category/terms",
		{
			terms: [{ id: "term_1", name: "news", slug: "news", label: "Preloaded term", children: [] }],
		},
	],
	[
		"/_emdash/api/taxonomies/tag/terms",
		{ terms: [{ id: "term_2", name: "tips", slug: "tips", label: "Preloaded tag", children: [] }] },
	],
	["/_emdash/api/taxonomies", { taxonomies: MANIFEST.taxonomies }],
];

const requests: string[] = [];

function requestCount(path: string): number {
	return requests.filter((url) => url.startsWith(path)).length;
}

const originalFetch = globalThis.fetch;

function mockApi() {
	requests.length = 0;
	globalThis.fetch = ((input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requests.push(url);
		const match = RESPONSES.find(([path]) => url.startsWith(path));
		return Promise.resolve(
			new Response(JSON.stringify(match ? { data: match[1] } : { error: { code: "NOT_FOUND" } }), {
				status: match ? 200 : 404,
				headers: { "Content-Type": "application/json" },
			}),
		);
	}) as typeof fetch;
}

function renderAdmin() {
	return render(
		<AdminApp
			locale="en"
			messages={{}}
			initialData={{
				manifest: MANIFEST,
				currentUser: { id: "user_1", email: "admin@example.com", role: 50 },
				commentCounts: { pending: 0, approved: 0, spam: 0, trash: 0 },
			}}
		/>,
	);
}

describe("hovering a sidebar link", () => {
	const initialUrl = window.location.href;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		window.history.replaceState(null, "", initialUrl);
	});

	it("loads the screen's data, so the screen opens with it and does not request it again", async () => {
		mockApi();
		window.history.replaceState(null, "", "/_emdash/admin/");
		const screen = await renderAdmin();
		await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();

		const screens = [
			{ link: "Widgets", data: ["/_emdash/api/widget-areas"], shows: "Main sidebar" },
			{
				link: "Posts",
				data: ["/_emdash/api/content/posts?", "/_emdash/api/content/posts/authors"],
				shows: "Preloaded post",
			},
			{
				link: "Categories",
				data: ["/_emdash/api/taxonomies/category/terms"],
				shows: "Preloaded term",
			},
		];
		for (const { link, data, shows } of screens) {
			const anchor = screen.getByRole("link", { name: link, exact: true });
			await anchor.hover();
			for (const path of data) {
				await expect.poll(() => requestCount(path), { message: `${link}: ${path}` }).toBe(1);
			}
			await anchor.click();
			await expect.element(screen.getByText(shows)).toBeVisible();
			// A second request would mean the screen's query missed the prefetched entry.
			for (const path of data) expect(requestCount(path), `${link}: ${path}`).toBe(1);
		}
	});

	it("loads an entry and its bylines when its row is hovered, so the editor opens with them", async () => {
		mockApi();
		window.history.replaceState(null, "", "/_emdash/admin/content/posts");
		const screen = await renderAdmin();
		const row = screen.getByRole("link", { name: "Preloaded post" });
		await expect.element(row).toBeVisible();

		await row.hover();
		await expect.poll(() => requestCount("/_emdash/api/content/posts/post_1?")).toBe(1);
		await expect.poll(() => requestCount("/_emdash/api/admin/bylines?")).toBe(1);
		await row.click();
		await expect.poll(() => window.location.pathname).toBe("/_emdash/admin/content/posts/post_1");
		await expect.element(screen.getByRole("heading", { name: "Edit Post" })).toBeVisible();
		await expect.element(screen.getByRole("textbox", { name: "Slug" })).toHaveValue("hello");

		expect(requestCount("/_emdash/api/content/posts/post_1?")).toBe(1);
		expect(requestCount("/_emdash/api/admin/bylines?")).toBe(1);
	});

	it("navigates in place and preloads when the link carries the URL's locale", async () => {
		mockApi();
		window.history.replaceState(null, "", "/_emdash/admin/?locale=en");
		const screen = await renderAdmin();
		await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		const marker = Symbol("same document");
		Object.assign(window, { [marker]: true });

		const anchor = screen.getByRole("link", { name: "Tags", exact: true });
		await expect.element(anchor).toHaveAttribute("href", expect.stringContaining("locale=en"));
		await anchor.hover();
		await expect.poll(() => requestCount("/_emdash/api/taxonomies/tag/terms")).toBe(1);
		await anchor.click();
		await expect.element(screen.getByText("Preloaded tag")).toBeVisible();

		expect(window.location.search).toBe("?locale=en");
		// A full page load would have replaced the window object and lost the marker.
		expect(marker in window).toBe(true);
	});
});

describe("navigating to a screen", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("starts the screen's data before the screen renders", async () => {
		mockApi();
		const queryClient = new QueryClient();
		queryClient.setQueryData(["manifest"], MANIFEST);
		const router = createAdminRouter(queryClient);

		router.history.push("/_emdash/admin/widgets");
		await router.load();

		expect(requestCount("/_emdash/api/widget-areas")).toBe(1);
		expect(requestCount("/_emdash/api/widget-components")).toBe(1);
		queryClient.clear();
	});
});
