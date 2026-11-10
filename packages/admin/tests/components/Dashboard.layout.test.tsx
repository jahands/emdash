import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { AdminManifest } from "../../src/lib/api";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import { expectStableLayout } from "../utils/layout-stability";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to: _to, params: _params, search: _search, ...props }: any) => (
			<a href="#" {...props}>
				{children}
			</a>
		),
	};
});

const statsRequest = vi.fn<() => Promise<DashboardStats>>();

vi.mock("../../src/lib/api/dashboard", async () => {
	const actual = await vi.importActual("../../src/lib/api/dashboard");
	return { ...actual, fetchDashboardStats: () => statsRequest() };
});

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: { id: "user_01", role: 50 } }),
}));

vi.mock("../../src/components/CoreUpdateBanner.js", () => ({ CoreUpdateBanner: () => null }));

const { Dashboard } = await import("../../src/components/Dashboard");

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "test",
	authMode: "passkey",
	collections: {
		posts: { label: "Posts", labelSingular: "Post", supports: [], hasSeo: false, fields: {} },
		pages: { label: "Pages", labelSingular: "Page", supports: [], hasSeo: false, fields: {} },
	},
	plugins: {},
};

const stats: DashboardStats = {
	collections: [
		{ slug: "posts", label: "Posts", total: 3, published: 2, draft: 1, scheduled: 0 },
		{ slug: "pages", label: "Pages", total: 1, published: 1, draft: 0, scheduled: 0 },
	],
	mediaCount: 4,
	userCount: 2,
	recentItems: Array.from({ length: 10 }, (_, index) => ({
		id: `r${index}`,
		collection: "posts",
		collectionLabel: "Posts",
		title: `Recent ${index}`,
		slug: `recent-${index}`,
		status: "published",
		updatedAt: "2026-01-01T00:00:00.000Z",
		authorId: null,
	})),
	schedulerHealth: { status: "ok" },
	policyRejectedScheduled: 0,
	policyRejections: [],
} as unknown as DashboardStats;

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe.each([
	["desktop", 1280, 800],
	["phone", 390, 844],
])("dashboard loading at %s width", (_label, width, height) => {
	it("keeps the page still when stats replace the placeholders", async () => {
		await page.viewport(width, height);
		let resolveStats!: (value: DashboardStats) => void;
		statsRequest.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveStats = resolve;
				}),
		);
		const i18n = setupI18n({ locale: "en", messages: { en: {} } });
		const screen = await render(
			<I18nProvider i18n={i18n}>
				<Dashboard manifest={manifest} />
			</I18nProvider>,
		);
		await expect.element(screen.getByRole("heading", { name: "Content" })).toBeInTheDocument();

		await expectStableLayout(async () => {
			resolveStats(stats);
			await expect.element(screen.getByText("Recent 9")).toBeInTheDocument();
		});
	});
});
