import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient, waitFor } from "./utils/test-helpers";

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => (
		<main style={{ height: 300, overflow: "auto" }}>{children}</main>
	),
}));

vi.mock("../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

vi.mock("../src/components/Settings.js", () => ({
	Settings: () => <div>Settings page</div>,
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
};

const PAGE_SIZE = 20;
const TOTAL = 60;

function row(pageNumber: number, index: number) {
	const id = `p${pageNumber}-${index}`;
	return {
		id,
		type: "posts",
		slug: id,
		status: "draft",
		data: { title: `Post ${id}` },
		authorId: "user_01",
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: "rev_01",
	};
}

function json(data: unknown) {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("content list position", () => {
	const originalFetch = globalThis.fetch;
	let listRequests: URL[];

	beforeEach(() => {
		listRequests = [];
		window.history.replaceState({}, "", "/");
		sessionStorage.clear();
		globalThis.fetch = ((input: string | URL | Request) => {
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				"http://emdash.local",
			);
			if (url.pathname === "/_emdash/api/manifest") return Promise.resolve(json(MANIFEST));
			if (url.pathname === "/_emdash/api/auth/me") {
				return Promise.resolve(json({ id: "user_01", email: "a@example.com", role: 50 }));
			}
			if (url.pathname === "/_emdash/api/content/posts") {
				listRequests.push(url);
				const pageNumber = Number(url.searchParams.get("page") ?? 1);
				return Promise.resolve(
					json({
						items: Array.from({ length: PAGE_SIZE }, (_, index) => row(pageNumber, index)),
						total: TOTAL,
					}),
				);
			}
			return Promise.resolve(json({ items: [], total: 0, authors: [] }));
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	async function openList() {
		const queryClient = createTestQueryClient();
		const router = createAdminRouter(queryClient);
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		await router.navigate({ to: "/content/$collection", params: { collection: "posts" } });
		const screen = await render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>,
		);
		await expect.element(screen.getByText("Post p1-0", { exact: true })).toBeInTheDocument();
		return { screen, router };
	}

	const main = () => document.querySelector("main") as HTMLElement;

	it("returns to the same page and scroll offset after Back", async () => {
		const { screen, router } = await openList();

		await screen.getByRole("button", { name: "Next page" }).click();
		await expect.element(screen.getByText("Post p2-0", { exact: true })).toBeInTheDocument();
		await waitFor(() => expect(router.state.location.search).toMatchObject({ page: 2 }));

		const scrolled = new Promise((resolve) =>
			main().addEventListener("scroll", resolve, { once: true }),
		);
		main().scrollTop = 400;
		await scrolled;

		await router.navigate({ to: "/settings" });
		await expect.element(screen.getByText("Settings page")).toBeInTheDocument();
		main().scrollTop = 0;

		router.history.back();
		await expect.element(screen.getByText("Post p2-0", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Post p1-0", { exact: true })).not.toBeInTheDocument();
		expect(router.state.location.search).toMatchObject({ page: 2 });
		await waitFor(() => expect(main().scrollTop).toBe(400));
	});

	it("keeps the list's filter with the page on Back", async () => {
		const { screen, router } = await openList();

		await screen.getByRole("combobox", { name: "Filter by status" }).click();
		await screen.getByRole("option", { name: "Draft" }).click();
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("status")).toBe("draft"));
		await screen.getByRole("button", { name: "Next page" }).click();
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("page")).toBe("2"));

		await router.navigate({ to: "/settings" });
		await expect.element(screen.getByText("Settings page")).toBeInTheDocument();
		listRequests.length = 0;

		router.history.back();
		await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
		const request = listRequests.at(-1)!;
		expect(request.searchParams.get("page")).toBe("2");
		expect(request.searchParams.get("status")).toBe("draft");
	});

	it("returns to the first page when a filter changes the list", async () => {
		const { screen, router } = await openList();

		await screen.getByRole("button", { name: "Next page" }).click();
		await waitFor(() => expect(router.state.location.search).toMatchObject({ page: 2 }));

		await screen.getByRole("combobox", { name: "Filter by status" }).click();
		await screen.getByRole("option", { name: "Draft" }).click();
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("page")).toBe("1"));
		await waitFor(() => expect(router.state.location.search).not.toHaveProperty("page", 2));
	});

	it("opens the page named in the URL", async () => {
		const queryClient = createTestQueryClient();
		const router = createAdminRouter(queryClient);
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
			search: { page: 3 },
		});
		const screen = await render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>,
		);
		await expect.element(screen.getByText("Post p3-0", { exact: true })).toBeInTheDocument();
	});

	it("does not leave the page when the URL names a page past the end", async () => {
		const { screen, router } = await openList();
		await router.navigate({
			to: "/content/$collection",
			params: { collection: "posts" },
			search: { page: 99 },
		});
		await expect.element(screen.getByText("Post p3-0", { exact: true })).toBeInTheDocument();
		await waitFor(() => expect(router.state.location.search).toMatchObject({ page: 3 }));
	});

	it("shows the search that produced the rows after Back and Forward within the list", async () => {
		const { screen, router } = await openList();
		const input = screen.getByRole("searchbox", { name: "Search Posts" });

		await input.fill("alpha");
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("q")).toBe("alpha"));
		await screen.getByRole("button", { name: "Next page" }).click();
		await waitFor(() => expect(router.state.location.search).toMatchObject({ page: 2 }));
		await input.fill("beta");
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("q")).toBe("beta"));
		await waitFor(() => expect(router.state.location.search).not.toHaveProperty("page"));

		// Each check waits past the search debounce, so replaced text that came back would show.
		const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

		router.history.back();
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("q")).toBe("alpha"));
		await settle();
		await expect.element(input).toHaveValue("alpha");
		expect(listRequests.at(-1)?.searchParams.get("q")).toBe("alpha");

		router.history.forward();
		await waitFor(() => expect(listRequests.at(-1)?.searchParams.get("q")).toBe("beta"));
		await settle();
		await expect.element(input).toHaveValue("beta");
		expect(listRequests.at(-1)?.searchParams.get("q")).toBe("beta");
	});
});
