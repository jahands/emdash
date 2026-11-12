// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const rendered = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const pluginAdmins = vi.hoisted(() => ({ demo: { pages: { "/settings": () => null } } }));

vi.mock("virtual:emdash/admin-loader", () => ({
	loadPluginAdmins: async () => ({ pluginAdmins }),
}));

vi.mock("virtual:emdash/auth-providers", () => ({ authProviders: {} }));

vi.mock("@emdash-cms/admin/app", () => ({
	AdminApp: (props: Record<string, unknown>) => {
		rendered.push(props);
		return createElement("p", null, "admin");
	},
}));

const MESSAGES_URL = `data:text/javascript,${encodeURIComponent(
	'export const messages = { "dashboard.title": ["لوحة التحكم"] };',
)}`;

async function untilRendered(): Promise<void> {
	const start = Date.now();
	while (rendered.length === 0 && Date.now() - start < 5000) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

describe("admin island wrapper", () => {
	let root: Root | undefined;

	afterEach(() => {
		root?.unmount();
		root = undefined;
		rendered.length = 0;
		vi.useRealTimers();
	});

	it("renders the admin with plugin admins and the preloaded catalog, without waiting on a timer", async () => {
		// React schedules its delayed Suspense reveal with setTimeout; with only
		// setTimeout faked, the admin can render only if nothing waits on it.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { default: AdminWrapper } = await import("../../../src/astro/routes/PluginRegistry.js");
		const container = document.createElement("div");
		document.body.append(container);

		root = createRoot(container);
		root.render(createElement(AdminWrapper, { locale: "ar", messagesUrl: MESSAGES_URL }));
		await untilRendered();

		expect(rendered.at(-1)).toMatchObject({
			locale: "ar",
			pluginAdmins,
			messages: { "dashboard.title": ["لوحة التحكم"] },
		});
		expect(container.textContent).toBe("admin");
	});
});
