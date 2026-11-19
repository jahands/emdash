import { Toasty } from "@cloudflare/kumo";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { ContentList } from "../../src/components/ContentList";
import { SocialSettings } from "../../src/components/settings/SocialSettings";
import type { ContentItem, SiteSettings } from "../../src/lib/api";
import { LiveSyncProvider, useAnnouncePresence } from "../../src/lib/realtime/LiveSyncProvider";
import { LEAVE_GRACE_MS } from "../../src/lib/realtime/presence";
import { TAB_ID } from "../../src/lib/realtime/tab-id";
import { setLiveQueryDefaults } from "../../src/lib/route-queries";
import { FakeSocket, openHub, ticketResponse, type PresenceEntry } from "../utils/fake-hub";
import { render } from "../utils/render";
import { createTestQueryClient } from "../utils/test-helpers";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			params: _params,
			search: _search,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			params?: Record<string, string>;
			search?: Record<string, unknown>;
		}) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
	};
});

const ME = { id: "me", email: "me@example.com", name: "Me", role: 50 };
const settings: Partial<SiteSettings> = { social: { twitter: "@first" } };

function json(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		headers: { "Content-Type": "application/json" },
	});
}

function person(name: string, overrides: Partial<PresenceEntry> = {}): PresenceEntry {
	const userId = name.toLowerCase();
	return { userId, name, clientId: `tab-${userId}`, activity: "viewing", ...overrides };
}

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, location.href).pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		if (path === "/_emdash/api/realtime" && method === "POST") return ticketResponse();
		if (path === "/_emdash/api/auth/me") return json(ME);
		if (path === "/_emdash/api/settings") return json(settings);
		return new Response(null, { status: 404 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function renderLive(ui: React.ReactNode, enabled = true) {
	const queryClient = createTestQueryClient();
	setLiveQueryDefaults(queryClient);
	return render(
		<QueryClientProvider client={queryClient}>
			<LiveSyncProvider enabled={enabled}>
				<Toasty>{ui}</Toasty>
			</LiveSyncProvider>
		</QueryClientProvider>,
	);
}

describe("a screen without a room", () => {
	it("tells the hub where the tab is, and that it is editing while it has unsaved changes", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		await vi.waitFor(() =>
			expect(socket.here()).toEqual({ topic: "settings", activity: "viewing" }),
		);

		await userEvent.type(screen.getByRole("textbox", { name: "Twitter" }), "x");

		await vi.waitFor(() =>
			expect(socket.here()).toEqual({ topic: "settings", activity: "editing" }),
		);
		await screen.unmount();
	});

	it("shows who else is here, leaving out this tab and this user's other tabs", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		await expect.element(screen.getByRole("textbox", { name: "Twitter" })).toHaveValue("@first");

		socket.presence(
			[
				{
					topic: "settings",
					people: [
						person("Ben", { activity: "editing" }),
						person("Me", { userId: "me", clientId: "my-other-tab" }),
						person("Me", { userId: "me", clientId: TAB_ID }),
					],
				},
			],
			true,
		);

		const here = screen.getByRole("img", { name: "1 other person here" });
		await expect.element(here).toBeVisible();
		await expect.element(here).toHaveTextContent("B");
	});

	it("keeps someone who left listed for a moment, then drops them", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		socket.presence([{ topic: "settings", people: [person("Ben")] }], true);
		const here = screen.getByRole("img", { name: "1 other person here" });
		await expect.element(here).toBeVisible();

		socket.presence([{ topic: "settings", people: [] }]);
		await new Promise((resolve) => setTimeout(resolve, LEAVE_GRACE_MS / 2));
		await expect.element(here).toBeVisible();

		await expect.poll(() => here.query(), { timeout: LEAVE_GRACE_MS * 2 }).toBeNull();
	});

	it("doesn't drop someone who comes back within the moment", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		socket.presence([{ topic: "settings", people: [person("Ben")] }], true);
		const here = screen.getByRole("img", { name: "1 other person here" });
		await expect.element(here).toBeVisible();

		socket.presence([{ topic: "settings", people: [] }]);
		socket.presence([{ topic: "settings", people: [person("Ben")] }]);
		await new Promise((resolve) => setTimeout(resolve, LEAVE_GRACE_MS * 1.5));

		await expect.element(here).toBeVisible();
	});

	it("forgets everyone when its socket closes, and says where it is again once it reopens", async () => {
		const screen = await renderLive(<SocialSettings />);
		const socket = await openHub(["settings"]);
		socket.presence([{ topic: "settings", people: [person("Ben")] }], true);
		const here = screen.getByRole("img", { name: "1 other person here" });
		await expect.element(here).toBeVisible();
		await vi.waitFor(() => expect(socket.here()?.topic).toBe("settings"));

		socket.drop(1006);

		await expect.poll(() => here.query(), { timeout: LEAVE_GRACE_MS * 2 }).toBeNull();
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
		const reopened = FakeSocket.instances[1]!;
		reopened.open();
		expect(reopened.topics()).toEqual(["settings"]);
		expect(reopened.here()).toEqual({ topic: "settings", activity: "viewing" });
	});
});

describe("announcing", () => {
	function Announce({ topic, activity }: { topic: string; activity: "viewing" | "editing" }) {
		useAnnouncePresence(topic, activity);
		return null;
	}

	it("uses the screen mounted last, goes back to the one before it, and says nowhere after both", async () => {
		function Screens() {
			const [shown, setShown] = React.useState(["menus", "widgets"]);
			return (
				<>
					{shown.includes("menus") && <Announce topic="menus/main" activity="viewing" />}
					{shown.includes("widgets") && <Announce topic="widgets" activity="editing" />}
					<button type="button" onClick={() => setShown(["menus"])}>
						back
					</button>
					<button type="button" onClick={() => setShown([])}>
						away
					</button>
				</>
			);
		}
		const screen = await renderLive(<Screens />);
		const socket = await openHub([]);
		await vi.waitFor(() =>
			expect(socket.here()).toEqual({ topic: "widgets", activity: "editing" }),
		);

		await screen.getByRole("button", { name: "back" }).click();
		await vi.waitFor(() =>
			expect(socket.here()).toEqual({ topic: "menus/main", activity: "viewing" }),
		);

		await screen.getByRole("button", { name: "away" }).click();
		await vi.waitFor(() => expect(socket.here()).toEqual({ topic: null }));
	});

	it("sends one frame when a screen swaps its activity", async () => {
		function Swapping() {
			const [editing, setEditing] = React.useState(false);
			useAnnouncePresence("content/posts/01A", editing ? "editing" : "viewing");
			return (
				<button type="button" onClick={() => setEditing(true)}>
					edit
				</button>
			);
		}
		const screen = await renderLive(<Swapping />);
		const socket = await openHub([]);
		await vi.waitFor(() => expect(socket.here()?.activity).toBe("viewing"));
		const sent = socket.sent.length;

		await screen.getByRole("button", { name: "edit" }).click();

		await vi.waitFor(() => expect(socket.here()?.activity).toBe("editing"));
		expect(socket.sent.slice(sent).map((frame) => JSON.parse(frame).t)).toEqual(["here"]);
	});
});

const posts: ContentItem[] = ["01A", "01B", "01C"].map((id) => ({
	id,
	type: "posts",
	slug: id.toLowerCase(),
	status: "draft",
	data: { title: `Post ${id}` },
	authorId: "me",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
}));

describe("the content list", () => {
	it("shows who is editing each entry, and not who is only viewing one", async () => {
		const screen = await renderLive(
			<ContentList collection="posts" collectionLabel="Posts" items={posts} />,
		);
		const socket = await openHub(["content/posts"]);

		socket.presence(
			[
				{ topic: "content/posts/01A", people: [person("Ana", { activity: "editing" })] },
				{
					topic: "content/posts/01B",
					people: [person("Ben", { activity: "editing" }), person("Cy", { activity: "editing" })],
				},
				{ topic: "content/posts/01C", people: [person("Di")] },
			],
			true,
		);

		await expect.element(screen.getByRole("img", { name: "Being edited by Ana" })).toBeVisible();
		const both = screen.getByRole("img", { name: "Being edited by Ben and Cy" });
		await expect.element(both).toHaveTextContent("2");
		expect(screen.getByRole("img", { name: /^Being edited by/ }).all()).toHaveLength(2);
	});

	it("keeps no room for faces where the host runs no hub", async () => {
		const screen = await renderLive(
			<ContentList collection="posts" collectionLabel="Posts" items={posts} />,
			false,
		);
		await expect.element(screen.getByRole("link", { name: "Post 01A" })).toBeVisible();

		expect(document.querySelector("[data-presence-slot]")).toBeNull();
	});
});
