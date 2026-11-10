import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCurrentUser } from "../src/lib/api/current-user.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.tsx";
import { createTestQueryClient, waitFor } from "./utils/test-helpers.js";

const { renderedRoles } = vi.hoisted(() => ({
	renderedRoles: [] as Array<number | undefined>,
}));

vi.mock("../src/components/Shell.js", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("../src/components/AdminCommandPalette.js", () => ({
	AdminCommandPalette: () => null,
}));

vi.mock("../src/components/Settings.js", () => ({
	Settings: function SettingsProbe() {
		const { data } = useCurrentUser();
		renderedRoles.push(data?.role);
		return <div>Settings page</div>;
	},
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function deferred() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("admin shell current-user gate", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		renderedRoles.length = 0;
	});

	async function open(manifest = deferred(), me = deferred()) {
		const requested: string[] = [];
		globalThis.fetch = ((input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requested.push(url);
			// Queries fetch again after the layout's loader has, so each read gets its own copy.
			if (url.startsWith("/_emdash/api/manifest")) return manifest.promise.then((r) => r.clone());
			if (url.startsWith("/_emdash/api/auth/me")) return me.promise.then((r) => r.clone());
			return Promise.resolve(json({ data: {} }));
		}) as typeof fetch;

		const queryClient = createTestQueryClient();
		const router = createAdminRouter(queryClient);
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		// The admin layout's loader waits for the manifest and the user, which the tests hold.
		void router.navigate({ to: "/settings" });
		const screen = await render(
			<I18nProvider i18n={i18n}>
				<QueryClientProvider client={queryClient}>
					<RouterProvider router={router} />
				</QueryClientProvider>
			</I18nProvider>,
		);
		return { screen, requested, manifest, me };
	}

	it("requests the user with the manifest and paints the page once, with the role known", async () => {
		const { screen, requested, manifest, me } = await open();

		await waitFor(() => requested.some((url) => url.startsWith("/_emdash/api/auth/me")));
		expect(requested.some((url) => url.startsWith("/_emdash/api/manifest"))).toBe(true);
		await expect.element(screen.getByText("Settings page")).not.toBeInTheDocument();

		manifest.resolve(json({ data: MANIFEST }));
		await new Promise((settle) => setTimeout(settle, 50));
		await expect.element(screen.getByText("Settings page")).not.toBeInTheDocument();

		me.resolve(json({ data: { id: "user_01", email: "a@example.com", role: 50 } }));
		await expect.element(screen.getByText("Settings page")).toBeInTheDocument();
		expect(renderedRoles).not.toContain(undefined);
		expect(renderedRoles).toContain(50);
	});

	it("still opens the admin when the user request fails", async () => {
		const { screen, manifest, me } = await open();

		manifest.resolve(json({ data: MANIFEST }));
		me.resolve(json({ error: { code: "INTERNAL", message: "boom" } }, 500));

		await expect.element(screen.getByText("Settings page")).toBeInTheDocument();
		expect(renderedRoles).toContain(undefined);
	});
});
