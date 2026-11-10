import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers";

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function json(data: unknown) {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("content types page", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("shows block types only once the collections table above has its rows", async () => {
		let resolveCollections!: (response: Response) => void;
		globalThis.fetch = ((input: string | URL | Request) => {
			const path = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				"http://emdash.local",
			).pathname;
			if (path === "/_emdash/api/manifest") return Promise.resolve(json(MANIFEST));
			if (path === "/_emdash/api/auth/me") {
				return Promise.resolve(json({ id: "user_01", email: "a@example.com", role: 50 }));
			}
			if (path === "/_emdash/api/schema/collections") {
				return new Promise<Response>((resolve) => {
					resolveCollections = resolve;
				});
			}
			return Promise.resolve(json({ items: [] }));
		}) as typeof fetch;

		const queryClient = createTestQueryClient();
		const router = createAdminRouter(queryClient);
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		await router.navigate({ to: "/content-types" });
		const screen = await render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>,
		);

		await expect.element(screen.getByText("Loading collections...")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("heading", { name: "Block types" }))
			.not.toBeInTheDocument();

		resolveCollections(json({ items: [] }));
		await expect.element(screen.getByRole("heading", { name: "Block types" })).toBeVisible();
	});
});
