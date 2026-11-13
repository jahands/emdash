import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lazyRouteModule } from "../../src/lib/route-module.js";
import { render } from "../utils/render";

const tab = vi.hoisted(() => ({ reloads: 0, chunkMissing: false, loaded: [] as string[] }));

vi.mock("../../src/lib/reload-page.js", () => ({
	reloadPage: () => {
		tab.reloads++;
	},
}));

vi.mock("../../src/route-module-loaders.js", () => ({
	ROUTE_MODULE_LOADERS: {
		"components/Dashboard": () => {
			tab.loaded.push("components/Dashboard");
			return tab.chunkMissing
				? Promise.reject(new TypeError("Failed to fetch dynamically imported module"))
				: Promise.resolve({ Dashboard: () => <p>Dashboard</p> });
		},
		"components/ContentEditor": () => {
			tab.loaded.push("components/ContentEditor");
			return Promise.resolve({ ContentEditor: () => <p>Editor</p> });
		},
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

	it("reloads once, then says the admin may have been updated, when the chunk stays missing", async () => {
		tab.chunkMissing = true;
		await openPage();
		await expect.poll(() => tab.reloads).toBe(1);

		const page = await openPage();
		const alert = page.getByRole("alert");
		await expect.element(alert).toHaveTextContent("This page couldn't load");
		await expect.element(alert).toHaveTextContent("The admin may have been updated.");
		expect(alert.element().textContent).not.toContain("connection");
		expect(tab.reloads).toBe(1);

		await page.getByRole("button", { name: "Reload page" }).click();
		expect(tab.reloads).toBe(2);
	});

	it("blames the connection when the server can't be reached", async () => {
		sessionStorage.setItem("emdash:route-module-reloaded:components/Dashboard", "1");
		const fetchSpy = vi.spyOn(window, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
		tab.chunkMissing = true;
		try {
			const page = await openPage();
			await expect
				.element(page.getByRole("alert"))
				.toHaveTextContent("The server can't be reached. Check your connection, then try again.");
			expect(tab.reloads).toBe(0);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("a route module that fails to load offline", () => {
	let online = false;

	beforeEach(() => {
		sessionStorage.clear();
		tab.reloads = 0;
		online = false;
		vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("says the browser is offline, then loads by itself once it's back online", async () => {
		tab.chunkMissing = true;
		const page = await openPage();
		const alert = page.getByRole("alert");
		await expect.element(alert).toHaveTextContent("You're offline");
		await expect.element(alert).toHaveTextContent("This page will load when you're back online.");
		expect(tab.reloads).toBe(0);

		tab.chunkMissing = false;
		online = true;
		window.dispatchEvent(new Event("online"));
		await expect.element(page.getByText("Dashboard")).toBeVisible();
		expect(tab.reloads).toBe(0);
	});
});
