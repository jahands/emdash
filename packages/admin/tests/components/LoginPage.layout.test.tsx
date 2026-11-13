import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { deferred, largestMovement, snapshotPositions } from "../utils/geometry.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

const mockFetchAuthMode = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchAuthMode: () => mockFetchAuthMode() };
});

Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

const { LoginPage } = await import("../../src/components/LoginPage.js");

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const [client] = React.useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	);
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("Login page while the sign-in options load", () => {
	afterEach(async () => {
		await page.viewport(1280, 800);
	});

	it.each([
		{ viewport: "phone", width: 390, height: 844, signupEnabled: false },
		{ viewport: "phone", width: 390, height: 844, signupEnabled: true },
		{ viewport: "desktop", width: 1440, height: 900, signupEnabled: false },
		{ viewport: "desktop", width: 1440, height: 900, signupEnabled: true },
	])(
		"keeps the logo, heading and sign-in card in place on a $viewport (signup enabled: $signupEnabled)",
		async ({ width, height, signupEnabled }) => {
			await page.viewport(width, height);
			const authMode = deferred<{ authMode: string; signupEnabled: boolean }>();
			mockFetchAuthMode.mockReturnValue(authMode.promise);

			const screen = await render(
				<QueryWrapper>
					<LoginPage />
				</QueryWrapper>,
			);
			const logo = screen.getByRole("img", { name: "EmDash" });
			await expect.element(logo).toBeVisible();
			const before = snapshotPositions(
				[
					logo.element(),
					document.querySelector("h1"),
					screen.getByText("Sign in with Passkey").query(),
				].filter((element) => element !== null),
			);

			authMode.resolve({ authMode: "passkey", signupEnabled });
			await expect
				.element(screen.getByRole("button", { name: "Sign in with Passkey" }))
				.toBeVisible();
			if (signupEnabled) await expect.element(screen.getByText("Sign up")).toBeVisible();

			expect(largestMovement(before)).toBeLessThanOrEqual(1);
		},
	);
});
