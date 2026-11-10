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
import { createTestQueryClient } from "./utils/test-helpers";

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock("../src/components/AdminCommandPalette", () => ({
	AdminCommandPalette: () => null,
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "settings-preload",
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

describe("settings routes", () => {
	const originalFetch = globalThis.fetch;
	let role: number;
	let settingsRequests: number;
	let releaseSettings: () => void;

	beforeEach(() => {
		role = 50;
		settingsRequests = 0;
		const settingsHeld = new Promise<void>((resolve) => {
			releaseSettings = resolve;
		});
		globalThis.fetch = (async (input: string | URL | Request) => {
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				"http://emdash.local",
			);
			if (url.pathname === "/_emdash/api/manifest") return json(MANIFEST);
			if (url.pathname === "/_emdash/api/auth/me") {
				return json({ id: "user_01", email: "a@example.com", role });
			}
			if (url.pathname === "/_emdash/api/settings") {
				settingsRequests++;
				await settingsHeld;
				return json({ title: "Preloaded title", tagline: "" });
			}
			return json({});
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	async function open(path: "/settings/seo" | "/settings/social") {
		const queryClient = createTestQueryClient();
		const router = createAdminRouter(queryClient);
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
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

	it.each(["/settings/seo", "/settings/social"] as const)(
		"opens %s with the form's data instead of a loading row",
		async (path) => {
			const screen = await open(path);
			await vi.waitFor(() => expect(settingsRequests).toBe(1));
			await new Promise((settle) => setTimeout(settle, 100));
			expect(screen.getByText("Loading settings...").query()).toBeNull();

			releaseSettings();
			await expect
				.element(screen.getByRole("button", { name: "Save" }).first())
				.toBeInTheDocument();
			expect(screen.getByText("Loading settings...").query()).toBeNull();
		},
	);

	it("does not request settings for someone who can't read them", async () => {
		role = 40;
		const screen = await open("/settings/seo");
		await expect.element(screen.getByText("Access denied")).toBeInTheDocument();
		expect(settingsRequests).toBe(0);
	});
});
