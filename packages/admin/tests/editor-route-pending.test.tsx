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
import { createMockFetch, createTestQueryClient } from "./utils/test-helpers";

const editorChunk = vi.hoisted(() => {
	let release!: () => void;
	const loaded = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { loaded, release };
});

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../src/components/ContentEditor", async () => {
	await editorChunk.loaded;
	return {
		ContentEditor: ({ item }: { item?: { data?: { title?: string } } }) => (
			<div data-testid="content-editor">{item?.data?.title}</div>
		),
	};
});

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
	i18n: undefined,
};

function post(id: string, title: string) {
	return {
		id,
		type: "posts",
		slug: id,
		status: "draft",
		locale: "en",
		translationGroup: null,
		data: { title },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-01T00:00:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
}

function buildApp() {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	}
	function TestApp() {
		return (
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		);
	}
	return { router, TestApp };
}

describe("opening an entry", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;
	let mockedFetch: typeof fetch;
	let releaseSecondEntry: () => void;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 60 } })
			.on("GET", "/_emdash/api/bylines", { data: { items: [] } })
			.on("GET", "/_emdash/api/users", { data: { items: [] } })
			.on("GET", "/_emdash/api/revisions", { data: { item: null } })
			.on("GET", "/_emdash/api/content/posts/post_1", { data: { item: post("post_1", "First") } })
			.on("GET", "/_emdash/api/content/posts/post_2", { data: { item: post("post_2", "Second") } })
			.on("GET", "/_emdash/api/content/posts/trash", { data: { items: [], total: 0 } })
			.on("GET", "/_emdash/api/content/posts", {
				data: { items: [post("post_1", "First"), post("post_2", "Second")], total: 2 },
			});
		const secondEntry = new Promise<void>((resolve) => {
			releaseSecondEntry = resolve;
		});
		mockedFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "/_emdash/api/content/posts/post_2") await secondEntry;
			return mockedFetch(input, init);
		}) as typeof fetch;
	});

	afterEach(() => {
		releaseSecondEntry();
		globalThis.fetch = mockedFetch;
		mockFetch.restore();
	});

	it("shows the editor's frame while the editor's code downloads", async () => {
		const { router, TestApp } = buildApp();
		await router.navigate({ to: "/content/$collection", params: { collection: "posts" } });
		const screen = await render(<TestApp />);
		await expect.element(screen.getByRole("link", { name: /add new/i })).toBeVisible();

		void router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		await expect.element(screen.getByRole("status", { name: "Loading entry" })).toBeVisible();
		expect(screen.getByRole("link", { name: /add new/i }).query()).toBeNull();

		editorChunk.release();
		await expect.element(screen.getByTestId("content-editor")).toHaveTextContent("First");
	});

	it("keeps the editor's frame, not the boot loader, while an entry loads", async () => {
		editorChunk.release();
		const { router, TestApp } = buildApp();
		await router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_1" },
		});
		const screen = await render(<TestApp />);
		await expect.element(screen.getByTestId("content-editor")).toHaveTextContent("First");

		void router.navigate({
			to: "/content/$collection/$id",
			params: { collection: "posts", id: "post_2" },
		});
		await expect.element(screen.getByRole("status", { name: "Loading entry" })).toBeVisible();
		expect(document.body.textContent).not.toContain("Loading configuration");

		releaseSecondEntry();
		await expect.element(screen.getByTestId("content-editor")).toHaveTextContent("Second");
	});
});
