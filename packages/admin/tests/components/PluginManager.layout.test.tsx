import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import type { AdminManifest, PluginInfo } from "../../src/lib/api";
import { deferred } from "../utils/geometry.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const mockFetchPlugins = vi.fn<() => Promise<PluginInfo[]>>();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchPlugins: () => mockFetchPlugins() };
});

const { PluginManager } = await import("../../src/components/PluginManager");

function plugin(id: string, name: string): PluginInfo {
	return {
		id,
		name,
		version: "1.0.0",
		description: `${name} keeps a record of changes.`,
		enabled: true,
		status: "active",
		capabilities: ["hooks"],
		hasAdminPages: false,
		hasDashboardWidgets: false,
		hasHooks: true,
		hasSettings: false,
	};
}

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "abc",
	collections: {},
	plugins: { "audit-log": { name: "Audit Log" }, seo: { name: "SEO Helper" } },
	taxonomies: [],
	authMode: "passkey",
};

describe("PluginManager while plugins load", () => {
	it("holds a card for each plugin in the manifest, as tall as the cards that replace them", async () => {
		const plugins = deferred<PluginInfo[]>();
		mockFetchPlugins.mockReturnValue(plugins.promise);
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

		const screen = await render(
			<QueryClientProvider client={client}>
				<Toasty>
					<div style={{ width: 720 }}>
						<PluginManager manifest={manifest} />
					</div>
				</Toasty>
			</QueryClientProvider>,
		);
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugins...");
		const heading = screen.getByRole("heading", { name: "Plugins", level: 1 }).element();
		const list = heading.closest(".space-y-6")!.children[1]!;
		const placeholderHeight = list.getBoundingClientRect().height;

		plugins.resolve([plugin("audit-log", "Audit Log"), plugin("seo", "SEO Helper")]);
		await expect.element(screen.getByRole("heading", { name: "SEO Helper" })).toBeVisible();

		expect(Math.abs(list.getBoundingClientRect().height - placeholderHeight)).toBeLessThanOrEqual(
			1,
		);
	});
});
