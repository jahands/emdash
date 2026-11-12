import { beforeEach, describe, expect, it, vi } from "vitest";

import { lazyRouteModule } from "../../src/lib/route-module.js";
import { render } from "../utils/render";

const tab = vi.hoisted(() => ({ reloads: 0, chunkMissing: false }));

vi.mock("../../src/lib/reload-page.js", () => ({
	reloadPage: () => {
		tab.reloads++;
	},
}));

vi.mock("../../src/route-module-loaders.js", () => ({
	ROUTE_MODULE_LOADERS: {
		"components/Dashboard": () =>
			tab.chunkMissing
				? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
				: Promise.resolve({ Dashboard: () => <p>Dashboard</p> }),
	},
}));

let openScreen: Awaited<ReturnType<typeof render>> | undefined;

/** Renders the dashboard as a freshly loaded page in the same tab would. */
async function openPage() {
	await openScreen?.unmount();
	const Dashboard = lazyRouteModule("components/Dashboard", "Dashboard");
	await Dashboard.preload();
	openScreen = await render(<Dashboard />);
	return openScreen;
}

describe("a route module whose chunk a deploy removed", () => {
	beforeEach(() => {
		openScreen = undefined;
		sessionStorage.clear();
		tab.reloads = 0;
		tab.chunkMissing = false;
	});

	it("reloads the page once for each deploy in the same tab", async () => {
		tab.chunkMissing = true;
		await openPage();
		await expect.poll(() => tab.reloads).toBe(1);

		tab.chunkMissing = false;
		let page = await openPage();
		await expect.element(page.getByText("Dashboard")).toBeVisible();

		tab.chunkMissing = true;
		await openPage();
		await expect.poll(() => tab.reloads).toBe(2);

		tab.chunkMissing = false;
		page = await openPage();
		await expect.element(page.getByText("Dashboard")).toBeVisible();
		expect(tab.reloads).toBe(2);
	});

	it("reloads once, then shows the error, when the chunk stays missing", async () => {
		tab.chunkMissing = true;
		await openPage();
		await expect.poll(() => tab.reloads).toBe(1);

		const page = await openPage();
		await expect.element(page.getByRole("alert")).toHaveTextContent("This page couldn't load");

		await page.getByRole("button", { name: "Try again" }).click();
		await expect.element(page.getByRole("alert")).toBeVisible();
		expect(tab.reloads).toBe(1);
	});
});
