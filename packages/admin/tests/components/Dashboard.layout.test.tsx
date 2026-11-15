import { focusManager } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { AdminManifest } from "../../src/lib/api";
import type { CoreUpdateStatus } from "../../src/lib/api/core-update.js";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import { PluginAdminProvider } from "../../src/lib/plugin-context";
import { deferred, largestMovement, snapshotPositions, watchMovement } from "../utils/geometry.js";
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
const mockFetchCoreUpdateStatus = vi.fn<() => Promise<CoreUpdateStatus>>();
const noUpdate: CoreUpdateStatus = {
	current: "1.0.0",
	latest: "1.0.0",
	updateAvailable: false,
	checkedAt: null,
};

vi.mock("../../src/lib/api/core-update.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/core-update.js");
	return { ...actual, fetchCoreUpdateStatus: () => mockFetchCoreUpdateStatus() };
});

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

function stats({
	admin,
	scheduled,
	recent = 4,
}: {
	admin: boolean;
	scheduled: number;
	recent?: number;
}): DashboardStats {
	return {
		collections: [
			{ slug: "pages", label: "Pages", total: 3, published: 2, draft: 1, scheduled: 0 },
			{ slug: "posts", label: "Posts", total: 61, published: 50, draft: 11 - scheduled, scheduled },
		],
		mediaCount: 12,
		userCount: admin ? 1 : undefined,
		recentItems: Array.from({ length: recent }, (_, i) => ({
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
	beforeEach(() => {
		mockFetchCoreUpdateStatus.mockResolvedValue(noUpdate);
	});

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
			const metrics = screen.getByTestId("dashboard-metric").elements();
			expect(metrics).toHaveLength(admin ? 4 : 3);
			const before = snapshotPositions([content.element(), activity.element(), ...metrics]);

			pending.resolve(stats({ admin, scheduled }));
			await expect.element(screen.getByRole("link", { name: "Post 3" })).toBeVisible();

			expect(largestMovement(before)).toBeLessThanOrEqual(1);
		},
	);

	it("names the metrics and collections before the stats arrive, and announces one status", async () => {
		mockUseCurrentUser.mockReturnValue({ data: { role: 50 } });
		const pending = deferred<DashboardStats>();
		mockFetchDashboardStats.mockReturnValue(pending.promise);

		const screen = await render(<Dashboard manifest={manifest} />);

		for (const label of ["Drafts", "Scheduled", "Media files", "Users"]) {
			await expect
				.element(screen.getByTestId("dashboard-metric").filter({ hasText: label }))
				.toBeVisible();
		}
		const collectionLinks = screen.container.querySelectorAll('a[href="/content/$collection"]');
		expect(Array.from(collectionLinks, (link) => link.textContent)).toEqual(["Posts", "Pages"]);
		expect(screen.getByRole("status").elements()).toHaveLength(1);

		pending.resolve(stats({ admin: true, scheduled: 2 }));
		await expect.element(screen.getByRole("link", { name: "Post 3" })).toBeVisible();
		expect(screen.getByRole("status").elements()).toHaveLength(0);
	});

	it("keeps the dashboard in place when a background refresh fails", async () => {
		await page.viewport(1440, 900);
		mockUseCurrentUser.mockReturnValue({ data: { role: 50 } });
		mockFetchDashboardStats.mockResolvedValue(stats({ admin: true, scheduled: 0 }));

		const screen = await render(<Dashboard manifest={manifest} />);
		await expect.element(screen.getByRole("link", { name: "Post 3" })).toBeVisible();
		const before = snapshotPositions([
			screen.getByRole("heading", { name: "Content", exact: true }).element(),
			...screen.getByTestId("dashboard-metric").elements(),
		]);

		mockFetchDashboardStats.mockRejectedValue(new Error("offline"));
		try {
			focusManager.setFocused(false);
			focusManager.setFocused(true);
			await expect.element(screen.getByText("Could not load dashboard data")).toBeVisible();
		} finally {
			focusManager.setFocused(undefined);
		}

		await expect.element(screen.getByRole("link", { name: "Post 3" })).toBeVisible();
		expect(largestMovement(before)).toBeLessThanOrEqual(1);
	});

	it("asks for the update status while the stats load", async () => {
		mockUseCurrentUser.mockReturnValue({ data: { role: 50 } });
		mockFetchCoreUpdateStatus.mockClear();
		mockFetchDashboardStats.mockReturnValue(deferred<DashboardStats>().promise);

		const screen = await render(<Dashboard manifest={manifest} />);
		await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();

		await expect.poll(() => mockFetchCoreUpdateStatus.mock.calls.length).toBe(1);
	});

	it.each([{ width: 390 }, { width: 1440 }])(
		"keeps the dashboard in place when the scheduler warning and update notice arrive ($width px)",
		async ({ width }) => {
			await page.viewport(width, 900);
			mockUseCurrentUser.mockReturnValue({ data: { role: 50 } });
			const pendingStats = deferred<DashboardStats>();
			const pendingUpdate = deferred<CoreUpdateStatus>();
			mockFetchDashboardStats.mockReturnValue(pendingStats.promise);
			mockFetchCoreUpdateStatus.mockReturnValue(pendingUpdate.promise);

			const screen = await render(<Dashboard manifest={manifest} />);
			const content = screen.getByRole("heading", { name: "Content", exact: true });
			const activity = screen.getByRole("heading", { name: "Recent Activity" });
			await expect.element(content).toBeVisible();
			const before = snapshotPositions([content.element(), activity.element()]);

			const overdue = stats({ admin: true, scheduled: 2 });
			overdue.collections[1]!.overdueScheduled = 2;
			overdue.schedulerHealth = { status: "stale", lastCompletedAt: "2026-01-01T00:00:00.000Z" };
			pendingStats.resolve(overdue);
			await expect.element(screen.getByRole("link", { name: "Post 3" })).toBeVisible();
			pendingUpdate.resolve({ ...noUpdate, latest: "1.1.0", updateAvailable: true });

			await expect
				.element(screen.getByText("Scheduled publishing needs attention"))
				.toBeInTheDocument();
			await expect
				.element(screen.getByText("EmDash 1.1.0 is available", { exact: false }))
				.toBeInTheDocument();
			expect(largestMovement(before)).toBeLessThanOrEqual(1);
		},
	);

	it.each([{ recent: 0 }, { recent: 3 }, { recent: 10 }])(
		"draws a plugin widget at once and keeps it in place when $recent recent items load",
		async ({ recent }) => {
			await page.viewport(390, 900);
			mockUseCurrentUser.mockReturnValue({ data: { role: 50 } });
			const pending = deferred<DashboardStats>();
			mockFetchDashboardStats.mockReturnValue(pending.promise);
			const withWidget: AdminManifest = {
				...manifest,
				plugins: {
					forms: { enabled: true, dashboardWidgets: [{ id: "overview", title: "Forms" }] },
				},
			};

			const screen = await render(
				<PluginAdminProvider
					pluginAdmins={{
						forms: { widgets: { overview: () => <div data-widget-body>Forms</div> } },
					}}
				>
					<Dashboard manifest={withWidget} />
				</PluginAdminProvider>,
			);
			await expect.element(screen.getByRole("heading", { name: "Forms" })).toBeVisible();
			const widget = watchMovement("[data-widget-body]");

			pending.resolve(stats({ admin: true, scheduled: 0, recent }));
			await expect
				.element(
					recent === 0
						? screen.getByText("No recent activity")
						: screen.getByRole("link", { name: `Post ${recent - 1}` }),
				)
				.toBeInTheDocument();
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

			expect(widget.stop()).toBeLessThanOrEqual(1);
		},
	);
});
