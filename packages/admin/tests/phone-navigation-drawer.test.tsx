import { LinkProvider, Toasty, type LinkComponentProps } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../dist/styles.css";
import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "phone-navigation-drawer",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function json(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }),
	);
}

function requestUrl(input: string | URL | Request) {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

async function renderPhoneAdmin() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 60_000 } },
	});
	const router = createAdminRouter(queryClient);
	await router.navigate({ to: "/" });
	const RouterAnchor = React.forwardRef<HTMLAnchorElement, LinkComponentProps>(
		({ href, to, children, ...props }, ref) => {
			const destination = String(href ?? to ?? "");
			return (
				<a
					ref={ref}
					href={destination}
					{...props}
					onClick={(event) => {
						props.onClick?.(event);
						event.preventDefault();
						void router.navigate({ to: destination.replace("/_emdash/admin", "") || "/" });
					}}
				>
					{children}
				</a>
			);
		},
	);
	RouterAnchor.displayName = "RouterAnchor";

	const screen = await render(
		<ThemeProvider defaultTheme="light">
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<LinkProvider component={RouterAnchor}>
							<RouterProvider router={router} />
						</LinkProvider>
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		</ThemeProvider>,
	);
	await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
	return { screen, router };
}

describe("phone navigation drawer", () => {
	let originalFetch: typeof fetch;

	beforeEach(async () => {
		originalFetch = globalThis.fetch;
		localStorage.clear();
		i18n.loadAndActivate({ locale: "en", messages: {} });
		await page.viewport(390, 800);
		globalThis.fetch = vi.fn((input: string | URL | Request) => {
			const url = requestUrl(input);
			if (url === "/_emdash/api/manifest") return json({ data: manifest });
			if (url === "/_emdash/api/auth/me") {
				return json({ data: { id: "ada", email: "ada@example.com", name: "Ada", role: 50 } });
			}
			if (url === "/_emdash/api/dashboard") {
				return json({ data: { collections: [], mediaCount: 0, userCount: 0, recentItems: [] } });
			}
			if (url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 0, approved: 0, spam: 0, trash: 0 } });
			}
			if (url === "/_emdash/api/admin/transfer/capabilities") {
				return json({
					data: { portableDomain: { empty: false, blockers: [], seededScaffold: [] } },
				});
			}
			if (url.startsWith("/_emdash/api/menus")) return json({ data: [] });
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		await page.viewport(1280, 800);
	});

	it("closes after a link is picked, and its toggle reports whether it is open", async () => {
		const { screen, router } = await renderPhoneAdmin();

		const openToggle = screen.getByRole("button", { name: "Open navigation" });
		await expect.element(openToggle).toHaveAttribute("aria-expanded", "false");
		await openToggle.click();

		const closeToggle = screen.getByRole("button", { name: "Close navigation" });
		await expect.element(closeToggle).toHaveAttribute("aria-expanded", "true");
		await screen.getByRole("link", { name: "Menus" }).click();

		await vi.waitFor(() => expect(router.state.location.pathname).toBe("/menus"));
		await expect.element(screen.getByRole("link", { name: "Menus" })).not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Open navigation" }))
			.toHaveAttribute("aria-expanded", "false");
	});
});
