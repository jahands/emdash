import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { AdminManifest } from "../../src/lib/api";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import { deferred, largestMovement, snapshotPositions } from "../utils/geometry.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params: _params, search: _search, ...props }: any) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
	};
});

const mockFetchDashboardStats = vi.fn<() => Promise<DashboardStats>>();
const mockUseCurrentUser = vi.fn();

vi.mock("../../src/lib/api/dashboard", async () => {
	const actual = await vi.importActual("../../src/lib/api/dashboard");
	return { ...actual, fetchDashboardStats: () => mockFetchDashboardStats() };
});

vi.mock("../../src/lib/api/current-user", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api/current-user")>()),
	useCurrentUser: () => mockUseCurrentUser(),
}));

const { Dashboard } = await import("../../src/components/Dashboard");

const collection = (label: string) => ({
	label,
	labelSingular: label,
	supports: [],
	hasSeo: false,
	fields: {},
});

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "test",
	authMode: "passkey",
	collections: { posts: collection("Posts"), pages: collection("Pages") },
	plugins: {},
};

function stats({ admin, scheduled }: { admin: boolean; scheduled: number }): DashboardStats {
	return {
		collections: [
			{ slug: "pages", label: "Pages", total: 3, published: 2, draft: 1, scheduled: 0 },
			{ slug: "posts", label: "Posts", total: 61, published: 50, draft: 11 - scheduled, scheduled },
		],
		mediaCount: 12,
		userCount: admin ? 1 : undefined,
		recentItems: Array.from({ length: 4 }, (_, i) => ({
			id: `post-${i}`,
			collection: "posts",
			collectionLabel: "Posts",
			title: `Post ${i}`,
			slug: `post-${i}`,
			status: "published",
			updatedAt: "2026-01-01T00:00:00.000Z",
			authorId: null,
		})),
		schedulerHealth: { status: "healthy", lastCompletedAt: new Date().toISOString() },
		policyRejectedScheduled: 0,
		policyRejections: [],
	};
}

describe("Dashboard while its stats load", () => {
	afterEach(async () => {
		await page.viewport(1280, 800);
	});

	it.each([
		{ viewport: "phone", width: 390, admin: true, scheduled: 0 },
		{ viewport: "phone", width: 390, admin: true, scheduled: 2 },
		{ viewport: "phone", width: 390, admin: false, scheduled: 0 },
		{ viewport: "phone", width: 390, admin: false, scheduled: 2 },
		{ viewport: "tablet", width: 800, admin: true, scheduled: 2 },
		{ viewport: "desktop", width: 1440, admin: true, scheduled: 0 },
		{ viewport: "desktop", width: 1440, admin: false, scheduled: 2 },
	])(
		"keeps the content and activity cards in place on a $viewport (admin: $admin, scheduled: $scheduled)",
		async ({ width, admin, scheduled }) => {
			await page.viewport(width, 900);
			mockUseCurrentUser.mockReturnValue({ data: { role: admin ? 50 : 40 } });
			const pending = deferred<DashboardStats>();
			mockFetchDashboardStats.mockReturnValue(pending.promise);

			const screen = await render(<Dashboard manifest={manifest} />);
			const content = screen.getByRole("heading", { name: "Content", exact: true });
			const activity = screen.getByRole("heading", { name: "Recent Activity" });
			await expect.element(content).toBeVisible();
			const before = snapshotPositions([content.element(), activity.element()]);

			pending.resolve(stats({ admin, scheduled }));
			await expect.element(screen.getByRole("link", { name: "Post 3" })).toBeVisible();

			expect(largestMovement(before)).toBeLessThanOrEqual(1);
		},
	);
});
