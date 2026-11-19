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

const chunks = vi.hoisted(() => {
	function held() {
		let release!: () => void;
		const loaded = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { loaded, release };
	}
	return { list: held(), settings: held(), contentType: held(), login: held() };
});

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../src/components/ContentList", async () => {
	await chunks.list.loaded;
	return { ContentList: () => <div data-testid="content-list" /> };
});

vi.mock("../src/components/settings/GeneralSettings", async () => {
	await chunks.settings.loaded;
	return { GeneralSettings: () => <div data-testid="general-settings" /> };
});

vi.mock("../src/components/LoginPage", async () => {
	await chunks.login.loaded;
	return { LoginPage: () => <div data-testid="login-page" /> };
});

vi.mock("../src/components/ContentTypeEditor", async () => {
	await chunks.contentType.loaded;
	return {
		ContentTypeEditor: ({ collection }: { collection?: { label: string } }) => (
			<div data-testid="content-type-editor">{collection?.label}</div>
		),
	};
});

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "shell-route-pending",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: [],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
};

function renderAdmin(path: string) {
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	void router.navigate({ to: path });
	return render(
		<I18nProvider i18n={i18n}>
			<Toasty>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</Toasty>
		</I18nProvider>,
	);
}

describe("a screen whose code is still loading", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } })
			.on("GET", "/_emdash/api/content/posts", { data: { items: [], total: 0 } })
			.on("GET", "/_emdash/api/settings", { data: {} })
			.on("GET", "/_emdash/api/schema", { data: { items: [] } });
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("shows the collection's name as the page heading, not a placeholder", async () => {
		const screen = await renderAdmin("/content/posts");

		await expect.element(screen.getByRole("heading", { level: 1, name: "Posts" })).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading");

		chunks.list.release();
		await expect.element(screen.getByTestId("content-list")).toBeInTheDocument();
	});

	it("shows the sign-in card in outline, as the page arrived, before the sign-in screen", async () => {
		const screen = await renderAdmin("/login");

		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading");
		expect(screen.container.querySelector(".emdash-standalone-card")).not.toBeNull();
		expect(screen.container.querySelector(".emdash-frame")).toBeNull();

		chunks.login.release();
		await expect.element(screen.getByTestId("login-page")).toBeInTheDocument();
		expect(screen.container.querySelector(".emdash-standalone")).toBeNull();
	});

	it("shows a settings page's heading and its way back to Settings", async () => {
		const screen = await renderAdmin("/settings/general");

		await expect
			.element(screen.getByRole("heading", { level: 1, name: "General Settings" }))
			.toBeVisible();
		await expect.element(screen.getByRole("link", { name: "Back to settings" })).toBeVisible();

		chunks.settings.release();
		await expect.element(screen.getByTestId("general-settings")).toBeInTheDocument();
	});

	it("shows the content type editor's header with the type's name until the type loads", async () => {
		let releaseCollection!: () => void;
		const collectionHeld = new Promise<void>((resolve) => {
			releaseCollection = resolve;
		});
		const fetchMocked = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith("/_emdash/api/schema/collections/posts")) {
				await collectionHeld;
				return Response.json({ data: { item: { slug: "posts", label: "Posts", fields: [] } } });
			}
			return fetchMocked(input, init);
		}) as typeof fetch;

		try {
			const screen = await renderAdmin("/content-types/posts");
			const heading = screen.getByRole("heading", { level: 1, name: "Posts" });
			const back = screen.getByRole("link", { name: "Back to Content Types" });
			await expect.element(heading).toBeVisible();
			await expect.element(back).toBeVisible();

			chunks.contentType.release();
			// Once the editor's code is in, the type itself is still loading.
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(screen.getByTestId("content-type-editor").query()).toBeNull();
			await expect.element(heading).toBeVisible();
			await expect.element(back).toBeVisible();

			releaseCollection();
			await expect.element(screen.getByTestId("content-type-editor")).toHaveTextContent("Posts");
		} finally {
			releaseCollection();
			globalThis.fetch = fetchMocked;
		}
	});
});
