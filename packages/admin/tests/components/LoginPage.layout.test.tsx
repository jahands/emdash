import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { AdminBrandingProvider } from "../../src/lib/admin-branding-context";
import { AuthProviderProvider } from "../../src/lib/auth-provider-context";
import { expectStableLayout } from "../utils/layout-stability";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const authModeRequest = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchAuthMode: () => authModeRequest() };
});

Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

const { LoginPage } = await import("../../src/components/LoginPage");

async function openHeldLogin() {
	let resolveMode!: (value: { authMode: string }) => void;
	authModeRequest.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				resolveMode = resolve;
			}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const i18n = setupI18n({ locale: "en", messages: { en: {} } });
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<QueryClientProvider client={client}>
				<AdminBrandingProvider adminBranding={{}}>
					<AuthProviderProvider authProviders={{}}>
						<LoginPage />
					</AuthProviderProvider>
				</AdminBrandingProvider>
			</QueryClientProvider>
		</I18nProvider>,
	);
	return { screen, resolveMode };
}

describe("login page loading", () => {
	it.each([
		["desktop", 1280, 800],
		["phone", 390, 844],
	])("keeps the sign-in card still at %s width when the auth mode arrives", async (_l, w, h) => {
		await page.viewport(w, h);
		const { screen, resolveMode } = await openHeldLogin();
		const heading = screen.getByRole("heading", { name: "Sign in to your site" });
		await expect.element(heading).toBeInTheDocument();

		await expectStableLayout(async () => {
			resolveMode({ authMode: "passkey" });
			await expect
				.element(screen.getByRole("button", { name: "Sign in with Passkey" }))
				.toBeVisible();
		});
		await page.viewport(1280, 800);
	});

	it("keeps sign-in controls hidden until the auth mode is known", async () => {
		const { screen, resolveMode } = await openHeldLogin();
		await expect.element(screen.getByText("Sign in to your site")).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Sign in with Passkey" }))
			.not.toBeInTheDocument();

		resolveMode({ authMode: "passkey" });
		await expect
			.element(screen.getByRole("button", { name: "Sign in with Passkey" }))
			.toBeVisible();
	});
});
