import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

import type { AdminManifest } from "../src/lib/api/index.js";
import { createAdminRouter } from "../src/router.js";
import { render } from "./utils/render.tsx";
import { createTestQueryClient, createMockFetch } from "./utils/test-helpers.js";

vi.mock("../src/components/Shell.js", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("../src/components/AdminCommandPalette.js", () => ({
	AdminCommandPalette: () => null,
}));

vi.mock("../src/routes/users.js", () => ({
	UsersPage: () => <div>Users page content</div>,
}));

vi.mock("../src/components/WordPressImport.js", () => ({
	WordPressImport: () => <div>WordPress import content</div>,
}));

vi.mock("../src/components/PluginSettings.js", () => ({
	PluginSettings: () => <div>Plugin settings content</div>,
}));

// Modules that also export siblings other modules import spread `importOriginal`;
// a bare factory would drop those exports and break the import graph.
vi.mock("../src/components/ContentTypeList.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/ContentTypeList.js")>()),
	ContentTypeList: () => <div>Content types content</div>,
}));

vi.mock("../src/components/PluginManager.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/PluginManager.js")>()),
	PluginManager: () => <div>Plugin manager content</div>,
}));

vi.mock("../src/components/Settings.js", () => ({
	Settings: () => <div>Settings content</div>,
}));

vi.mock("../src/components/settings/AllowedDomainsSettings.js", () => ({
	AllowedDomainsSettings: () => <div>Allowed domains content</div>,
}));

vi.mock("../src/components/settings/ApiTokenSettings.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/components/settings/ApiTokenSettings.js")>()),
	ApiTokenSettings: () => <div>API tokens content</div>,
}));

vi.mock("../src/components/settings/BackupSettings.js", () => ({
	BackupSettings: () => <div>Backups content</div>,
}));

vi.mock("../src/components/settings/EmailSettings.js", () => ({
	EmailSettings: () => <div>Email settings content</div>,
}));

vi.mock("../src/components/settings/GeneralSettings.js", () => ({
	GeneralSettings: () => <div>General settings content</div>,
}));

vi.mock("../src/components/settings/SeoSettings.js", () => ({
	SeoSettings: () => <div>SEO settings content</div>,
}));

vi.mock("../src/components/settings/SocialSettings.js", () => ({
	SocialSettings: () => <div>Social settings content</div>,
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function buildRouter() {
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

const WRAPPED_ROUTES: Array<[string, string]> = [
	["/settings/allowed-domains", "Allowed domains content"],
	["/settings/api-tokens", "API tokens content"],
	["/settings/email", "Email settings content"],
	["/settings/backups", "Backups content"],
	["/settings/general", "General settings content"],
	["/settings/social", "Social settings content"],
	["/settings/seo", "SEO settings content"],
	["/users", "Users page content"],
	["/import/wordpress", "WordPress import content"],
	["/plugins-manager/test-plugin/settings", "Plugin settings content"],
];

// Routes that must stay reachable for a non-admin (Editor-tier reads).
const UNWRAPPED_ROUTES: Array<[string, string]> = [
	["/settings", "Settings content"],
	["/content-types", "Content types content"],
	["/plugins-manager", "Plugin manager content"],
	["/plugins/marketplace", "Marketplace browsing is no longer available."],
	["/themes/marketplace", "Marketplace browsing is no longer available."],
];

describe("admin-only routes show Access denied to non-admins", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	afterEach(() => {
		mockFetch.restore();
	});

	it.each(WRAPPED_ROUTES)(
		"shows Access denied instead of %s for a non-admin (Editor) user",
		async (to, marker) => {
			mockFetch = createMockFetch();
			mockFetch
				.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
				.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } });

			const { router, TestApp } = buildRouter();
			await router.navigate({ to });
			const screen = await render(<TestApp />);

			await expect.element(screen.getByText("Access denied")).toBeInTheDocument();
			await expect.element(screen.getByText(marker)).not.toBeInTheDocument();
		},
	);

	it.each(WRAPPED_ROUTES)("renders %s for an admin", async (to, marker) => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } });

		const { router, TestApp } = buildRouter();
		await router.navigate({ to });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByText(marker)).toBeInTheDocument();
		await expect.element(screen.getByText("Access denied")).not.toBeInTheDocument();
	});
});

describe("routes that stay reachable for non-admins", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	afterEach(() => {
		mockFetch.restore();
	});

	it.each(UNWRAPPED_ROUTES)("renders %s for a non-admin (Editor) user", async (to, marker) => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } })
			// `/content-types` shows an ErrorScreen instead of the marker if any schema query fails.
			.on("GET", "/_emdash/api/schema/collections", { data: { items: [] } })
			.on("GET", "/_emdash/api/schema/orphans", { data: { items: [] } })
			.on("GET", "/_emdash/api/schema/block-types", { data: { items: [] } });

		const { router, TestApp } = buildRouter();
		await router.navigate({ to });
		const screen = await render(<TestApp />);

		await expect.element(screen.getByText(marker)).toBeInTheDocument();
		await expect.element(screen.getByText("Access denied")).not.toBeInTheDocument();
	});
});

describe("read permission gates", () => {
	it.each(["/redirects", "/content-types", "/plugins-manager"])(
		"denies a contributor at %s before requesting protected data",
		async (to) => {
			const mockFetch = createMockFetch();
			mockFetch
				.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
				.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 20 } });
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			try {
				const { router, TestApp } = buildRouter();
				await router.navigate({ to });
				const screen = await render(<TestApp />);
				await expect.element(screen.getByText("Access denied")).toBeInTheDocument();
				expect(
					fetchSpy.mock.calls.some(([url]) =>
						/\/(redirects|schema|relations|admin\/plugins)(\/|\?|$)/.test(
							typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
						),
					),
				).toBe(false);
			} finally {
				fetchSpy.mockRestore();
				mockFetch.restore();
			}
		},
	);
});

describe("read permission gates when the user lookup fails", () => {
	const PROTECTED_DATA = /\/(redirects|schema|relations|admin\/plugins)(\/|\?|$)/;
	const requestedProtectedData = (
		fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>,
	) =>
		fetchSpy.mock.calls.some(([url]) =>
			PROTECTED_DATA.test(typeof url === "string" ? url : url instanceof URL ? url.href : url.url),
		);

	it.each(["/redirects", "/content-types", "/plugins-manager"])(
		"offers Retry at %s instead of Access denied, without requesting protected data",
		async (to) => {
			const mockFetch = createMockFetch();
			mockFetch
				.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
				.on("GET", "/_emdash/api/auth/me", { error: { code: "INTERNAL_ERROR" } }, 500);
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			try {
				const { router, TestApp } = buildRouter();
				await router.navigate({ to });
				const screen = await render(<TestApp />);

				await expect.element(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
				await expect.element(screen.getByText("Access denied")).not.toBeInTheDocument();
				expect(requestedProtectedData(fetchSpy)).toBe(false);
			} finally {
				fetchSpy.mockRestore();
				mockFetch.restore();
			}
		},
	);

	it.each([
		["/content-types", "Content types content"],
		["/plugins-manager", "Plugin manager content"],
	])("opens %s after Retry once the user lookup succeeds", async (to, marker) => {
		const mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { error: { code: "INTERNAL_ERROR" } }, 500)
			.on("GET", "/_emdash/api/schema/collections", { data: { items: [] } })
			.on("GET", "/_emdash/api/schema/orphans", { data: { items: [] } })
			.on("GET", "/_emdash/api/schema/block-types", { data: { items: [] } });
		try {
			const { router, TestApp } = buildRouter();
			await router.navigate({ to });
			const screen = await render(<TestApp />);
			const retry = screen.getByRole("button", { name: "Retry" });
			await expect.element(retry).toBeInTheDocument();

			mockFetch.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 40 } });
			await retry.click();

			await expect.element(screen.getByText(marker)).toBeInTheDocument();
			await expect.element(screen.getByText("Access denied")).not.toBeInTheDocument();
		} finally {
			mockFetch.restore();
		}
	});
});
