import { Toasty } from "@cloudflare/kumo";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { SocialSettings } from "../../src/components/settings/SocialSettings";
import { Widgets } from "../../src/components/Widgets";
import type { AdminManifest, SiteSettings, WidgetArea } from "../../src/lib/api";
import { fetchManifest } from "../../src/lib/api/client";
import { LiveSyncProvider } from "../../src/lib/realtime/LiveSyncProvider";
import { setLiveQueryDefaults } from "../../src/lib/route-queries";
import { FakeSocket, openHub, ticketResponse } from "../utils/fake-hub";
import { render } from "../utils/render";
import { createTestQueryClient } from "../utils/test-helpers";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: { children: React.ReactNode; to?: string }) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
	};
});

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "live",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

const server = {
	settings: {} as Partial<SiteSettings>,
	areas: [] as WidgetArea[],
	reads: {} as Record<string, number>,
};

function json(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	server.settings = { social: { twitter: "@first" } };
	server.areas = [
		{
			id: "area_1",
			name: "sidebar",
			label: "Sidebar",
			widgets: [{ id: "w1", type: "content", title: "Recent posts", content: [] }],
		},
	];
	server.reads = {};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, location.href).pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		if (path === "/_emdash/api/realtime" && method === "POST") return ticketResponse();
		if (method === "GET") server.reads[path] = (server.reads[path] ?? 0) + 1;
		switch (path) {
			case "/_emdash/api/settings":
				return json(server.settings);
			case "/_emdash/api/widget-areas":
				return json({ items: server.areas });
			case "/_emdash/api/widget-components":
				return json({ items: [] });
			case "/_emdash/api/manifest":
				return json(MANIFEST);
			default:
				return new Response(null, { status: 404 });
		}
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const reads = (path: string) => server.reads[`/_emdash/api/${path}`] ?? 0;

async function renderLive(ui: React.ReactNode) {
	const queryClient = createTestQueryClient();
	setLiveQueryDefaults(queryClient);
	return render(
		<QueryClientProvider client={queryClient}>
			<LiveSyncProvider enabled>
				<Toasty>{ui}</Toasty>
			</LiveSyncProvider>
		</QueryClientProvider>,
	);
}

describe("the manifest", () => {
	function ManifestReaders() {
		// Screens read the manifest with their own options; none of them name its topics.
		useQuery({ queryKey: ["manifest"], queryFn: fetchManifest });
		useQuery({ queryKey: ["manifest"], queryFn: fetchManifest, staleTime: 0 });
		return null;
	}

	it("refetches when the schema, settings or plugins change, whichever screen read it last", async () => {
		await renderLive(<ManifestReaders />);
		const socket = await openHub(["plugins", "schema", "settings"]);
		await vi.waitFor(() => expect(reads("manifest")).toBe(1));

		socket.change("schema", { op: "update" });

		await vi.waitFor(() => expect(reads("manifest")).toBe(2));
	});
});

describe("a settings form", () => {
	it("takes another tab's change while it has no unsaved edits", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		const twitter = screen.getByRole("textbox", { name: "Twitter" });
		await expect.element(twitter).toHaveValue("@first");

		server.settings = { social: { twitter: "@second" } };
		socket.change("settings", { op: "update" });

		await expect.element(twitter).toHaveValue("@second");
		expect(screen.getByText("This changed somewhere else").query()).toBeNull();
	});

	it("keeps unsaved edits and offers the new version instead of refetching", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		const twitter = screen.getByRole("textbox", { name: "Twitter" });
		await expect.element(twitter).toHaveValue("@first");
		await userEvent.clear(twitter);
		await userEvent.type(twitter, "@mine");

		server.settings = { social: { twitter: "@theirs" } };
		socket.change("settings", { op: "update" });

		await expect.element(screen.getByText("This changed somewhere else")).toBeVisible();
		expect(reads("settings")).toBe(1);
		await expect.element(twitter).toHaveValue("@mine");

		await screen.getByRole("button", { name: "Load new version" }).click();

		await expect.element(twitter).toHaveValue("@theirs");
		expect(reads("settings")).toBe(2);
		expect(screen.getByText("This changed somewhere else").query()).toBeNull();
	});

	it("catches up once its edits are undone", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		const twitter = screen.getByRole("textbox", { name: "Twitter" });
		await expect.element(twitter).toHaveValue("@first");
		await userEvent.type(twitter, "x");

		server.settings = { social: { twitter: "@theirs" } };
		socket.change("settings", { op: "update" });
		await expect.element(screen.getByText("This changed somewhere else")).toBeVisible();

		await userEvent.keyboard("{Backspace}");

		await expect.element(twitter).toHaveValue("@theirs");
	});
});

describe("the widgets screen", () => {
	it("refetches its areas and updates a widget's editor that has no edits", async () => {
		const screen = await renderLive(<Widgets />);
		const socket = await openHub(["widgets"]);
		await screen.getByRole("button", { name: "Recent posts (content)" }).click();
		const title = screen.getByRole("textbox", { name: "Title" });
		await expect.element(title).toHaveValue("Recent posts");

		server.areas = [
			{
				...server.areas[0]!,
				widgets: [{ id: "w1", type: "content", title: "Latest posts", content: [] }],
			},
		];
		socket.change("widgets", { ids: ["w1"], op: "update" });

		await expect.element(title).toHaveValue("Latest posts");
		expect(reads("widget-areas")).toBe(2);
	});

	it("keeps a widget editor's unsaved edits and offers the new version", async () => {
		const screen = await renderLive(<Widgets />);
		const socket = await openHub(["widgets"]);
		await screen.getByRole("button", { name: "Recent posts (content)" }).click();
		const title = screen.getByRole("textbox", { name: "Title" });
		await userEvent.fill(title, "My title");

		server.areas = [
			{
				...server.areas[0]!,
				widgets: [{ id: "w1", type: "content", title: "Their title", content: [] }],
			},
		];
		socket.change("widgets", { ids: ["w1"], op: "update" });

		await expect.element(screen.getByText("This changed somewhere else")).toBeVisible();
		await expect.element(title).toHaveValue("My title");

		await screen.getByRole("button", { name: "Load new version" }).click();

		await expect.element(title).toHaveValue("Their title");
		expect(screen.getByText("This changed somewhere else").query()).toBeNull();
	});
});
