// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const pluginAdmins = vi.hoisted(() => ({ demo: { pages: { "/settings": () => null } } }));
const pluginAdminLoads = vi.hoisted(() => ({ failuresLeft: 0 }));

vi.mock("virtual:emdash/admin-loader", () => ({
	loadPluginAdmins: async () => {
		if (pluginAdminLoads.failuresLeft > 0) {
			pluginAdminLoads.failuresLeft--;
			throw new TypeError("Failed to fetch dynamically imported module");
		}
		return { pluginAdmins };
	},
}));

vi.mock("virtual:emdash/auth-providers", () => ({ authProviders: {} }));

vi.mock("@emdash-cms/admin/app", () => ({
	AdminApp: (props: Record<string, unknown>) => {
		rendered.push(props);
		return createElement("p", null, "admin");
	},
	AdminBootError: ({
		labels,
		retrying,
		onRetry,
	}: {
		labels: { title: string; retry: string };
		retrying: boolean;
		onRetry: () => void;
	}) =>
		createElement(
			"div",
			{ role: "alert" },
			labels.title,
			createElement("button", { onClick: onRetry, disabled: retrying }, labels.retry),
		),
}));

const MESSAGES_URL = `data:text/javascript,${encodeURIComponent(
	'export const messages = { "dashboard.title": ["لوحة التحكم"] };',
)}`;
const UNLOADED_MESSAGES_URL = `${MESSAGES_URL}%0A`;
const BOOT_ERROR_LABELS = { title: "فشل تحميل لوحة الإدارة", retry: "حاول مجددًا" };

async function until(condition: () => boolean): Promise<void> {
	const start = Date.now();
	while (!condition() && Date.now() - start < 4000) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

async function untilRendered(): Promise<void> {
	await until(() => rendered.length > 0);
}

describe("admin island wrapper", () => {
	let root: Root | undefined;

	afterEach(() => {
		root?.unmount();
		root = undefined;
		rendered.length = 0;
		pluginAdminLoads.failuresLeft = 0;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	async function renderWrapper(messagesUrl: string) {
		const { default: AdminWrapper } = await import("../../../src/astro/routes/PluginRegistry.js");
		const container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		root.render(
			createElement(AdminWrapper, {
				locale: "ar",
				messagesUrl,
				bootErrorLabels: BOOT_ERROR_LABELS,
			}),
		);
		return container;
	}

	async function untilBootError(container: HTMLElement): Promise<void> {
		await until(() => container.querySelector('[role="alert"]') !== null);
		expect(rendered).toHaveLength(0);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			BOOT_ERROR_LABELS.title,
		);
	}

	it("renders the admin with plugin admins and the preloaded catalog, without waiting on a timer", async () => {
		// React schedules its delayed Suspense reveal with setTimeout; with only
		// setTimeout faked, the admin can render only if nothing waits on it.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const container = await renderWrapper(MESSAGES_URL);
		await untilRendered();

		expect(rendered.at(-1)).toMatchObject({
			locale: "ar",
			pluginAdmins,
			messages: { "dashboard.title": ["لوحة التحكم"] },
		});
		expect(container.textContent).toBe("admin");
	});

	it("shows the boot error when plugin admins fail to load, and loads them again on Retry", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		pluginAdminLoads.failuresLeft = 1;
		const container = await renderWrapper(UNLOADED_MESSAGES_URL);

		await untilBootError(container);
		container.querySelector("button")!.click();
		await untilRendered();

		expect(rendered.at(-1)).toMatchObject({ pluginAdmins });
		expect(container.textContent).toBe("admin");
	});

	it("shows the boot error when the catalog fails to load", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const container = await renderWrapper("data:text/javascript,throw new TypeError('offline')");

		await untilBootError(container);
	});
});
