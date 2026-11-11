import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../../dist/styles.css";
import type { AdminManifest, SiteDomain, SiteSettings } from "../../../src/lib/api";
import type { BackupOverview } from "../../../src/lib/api/backups.js";
import {
	deferred,
	largestMovement,
	snapshotPositions,
	watchMovement,
} from "../../utils/geometry.js";
import { render } from "../../utils/render.js";

const mockFetchSettings = vi.fn<() => Promise<Partial<SiteSettings>>>();
const mockFetchBackupOverview = vi.fn<() => Promise<BackupOverview>>();
const mockFetchSiteDomain = vi.fn<() => Promise<SiteDomain>>();

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

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		fetchSettings: () => mockFetchSettings(),
		fetchSiteDomain: () => mockFetchSiteDomain(),
		fetchManifest: async () =>
			({
				version: "test",
				hash: "test",
				collections: {},
				plugins: {},
				authMode: "passkey",
			}) as AdminManifest,
		fetchEmailSettings: async () => ({ available: false }),
	};
});

vi.mock("../../../src/lib/api/backups.js", async () => {
	const actual = await vi.importActual("../../../src/lib/api/backups.js");
	return { ...actual, fetchBackupOverview: () => mockFetchBackupOverview() };
});

vi.mock("../../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "admin", email: "admin@example.com", role: 50 } }),
}));

const { GeneralSettings } = await import("../../../src/components/settings/GeneralSettings.js");
const { SeoSettings } = await import("../../../src/components/settings/SeoSettings.js");
const { SocialSettings } = await import("../../../src/components/settings/SocialSettings.js");
const { BackupSettings } = await import("../../../src/components/settings/BackupSettings.js");

const settings: Partial<SiteSettings> = {
	title: "My Blog",
	tagline: "Thoughts on building for the web",
	url: "https://example.com",
	postsPerPage: 10,
	dateFormat: "MMMM d, yyyy",
	timezone: "UTC",
	social: {},
	seo: {},
};

const overview: BackupOverview = {
	settings: { enabled: false, retention: 7 },
	archives: [],
	storageAvailable: true,
};

const pages = [
	{ name: "General", Page: GeneralSettings, release: "settings" },
	{ name: "SEO", Page: SeoSettings, release: "settings" },
	{ name: "Social", Page: SocialSettings, release: "settings" },
	{ name: "Backups", Page: BackupSettings, release: "backups" },
] as const;

describe("Settings pages while their settings load", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchSiteDomain.mockResolvedValue({
			configuredUrl: null,
			siteOrigin: window.location.origin,
		});
	});

	it.each(pages)(
		"keep the $name header and content in place at phone width when the settings arrive",
		async ({ Page, release }) => {
			const pendingSettings = deferred<Partial<SiteSettings>>();
			const pendingOverview = deferred<BackupOverview>();
			mockFetchSettings.mockReturnValue(pendingSettings.promise);
			mockFetchBackupOverview.mockReturnValue(pendingOverview.promise);

			const screen = await render(
				<Toasty>
					<div style={{ width: 358 }}>
						<Page />
					</div>
				</Toasty>,
			);
			await expect.element(screen.getByRole("status").first()).toBeVisible();
			const heading = screen.getByRole("heading", { level: 1 }).element();
			const header = heading.closest("[data-editor-header]")!;
			const content = header.nextElementSibling!;
			const headerBefore = snapshotPositions([heading, header]);
			const contentBefore = snapshotPositions([content]);

			if (release === "settings") pendingSettings.resolve(settings);
			else pendingOverview.resolve(overview);
			await expect.element(screen.getByRole("button", { name: "Saved" }).first()).toBeVisible();

			expect(largestMovement(headerBefore)).toBeLessThanOrEqual(1);
			expect(largestMovement(contentBefore, { includeSize: false })).toBeLessThanOrEqual(1);
		},
	);

	it("keeps the General form in place when the site address answers after the settings", async () => {
		const siteDomain = deferred<SiteDomain>();
		mockFetchSettings.mockResolvedValue(settings);
		mockFetchSiteDomain.mockReturnValue(siteDomain.promise);

		const headings = watchMovement("h1, h2");
		const screen = await render(
			<Toasty>
				<GeneralSettings />
			</Toasty>,
		);
		await vi.waitFor(() => expect(mockFetchSettings).toHaveBeenCalled());
		await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));

		siteDomain.resolve({
			configuredUrl: "https://cms.example.com",
			siteOrigin: "https://cms.example.com",
		});
		await expect
			.element(
				screen.getByText("Links in emails and plugins use https://cms.example.com", {
					exact: false,
				}),
			)
			.toBeVisible();
		await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));

		expect(headings.stop()).toBeLessThanOrEqual(1);
	});
});
