/**
 * Live updates on the entry editor page: outside a room the entry follows changes made elsewhere,
 * and in a room it leaves them to the room.
 */

import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { ThemeProvider } from "../../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../../src/lib/api";
import type { CoEditing } from "../../src/lib/co-editing/types";
import { setLiveQueryDefaults } from "../../src/lib/route-queries";
import { createAdminRouter } from "../../src/router";
import { FakeSocket, openHub, ticketResponse } from "../utils/fake-hub";
import { render } from "../utils/render.tsx";
import { createRoom } from "./fake-room";

const session = vi.hoisted(() => ({ view: null as unknown }));
vi.mock("../../src/lib/co-editing/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/co-editing/hooks")>();
	return { ...actual, useCoEditing: () => session.view };
});

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "live-entry",
	authMode: "passkey",
	realtime: true,
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
};

const ENTRY_TOPIC = "content/posts/post_1";
const ENTRY_PATH = "/_emdash/api/content/posts/post_1";

function entry(title: string): ContentItem {
	return {
		id: "post_1",
		type: "posts",
		slug: "post-one",
		status: "draft",
		locale: "en",
		translationGroup: "post_1",
		data: { title },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-02T00:00:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
}

const server = { item: entry("First"), reads: {} as Record<string, number> };

function json(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	server.item = entry("First");
	server.reads = {};
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const path = new URL(url, location.href).pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		if (path === "/_emdash/api/realtime" && method === "POST") return ticketResponse();
		if (method === "GET") server.reads[path] = (server.reads[path] ?? 0) + 1;
		if (path === "/_emdash/api/manifest") return json(MANIFEST);
		if (path === "/_emdash/api/auth/me") return json({ id: "user_1", role: 40 });
		if (path.startsWith("/_emdash/api/bylines") || path === "/_emdash/api/users") {
			return json({ items: [] });
		}
		if (path.endsWith("/revisions")) return json({ items: [], total: 0 });
		if (path === `${ENTRY_PATH}/lock`) {
			return json({ enabled: false, holder: null, heldByCaller: false, room: false });
		}
		if (path === ENTRY_PATH && method === "GET") {
			return json({ item: server.item, _rev: `rev-${String(server.item.data.title)}` });
		}
		// An autosave never answers, so the form keeps its edits for as long as a test runs.
		if (path === ENTRY_PATH && method === "PUT") return new Promise<Response>(() => undefined);
		return new Response(null, { status: 404 });
	});
});

let unmount: (() => Promise<void>) | undefined;

afterEach(async () => {
	await unmount?.();
	unmount = undefined;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const entryReads = () => server.reads[ENTRY_PATH] ?? 0;

async function openEntry(view: CoEditing) {
	session.view = view;
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	setLiveQueryDefaults(queryClient);
	const router = createAdminRouter(queryClient);
	if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post_1" },
	});
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<ThemeProvider defaultTheme="light">
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</ThemeProvider>
		</I18nProvider>,
	);
	unmount = () => screen.unmount();
	const title = screen.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(title).toHaveValue("First");
	return { screen, title };
}

const SINGLE_EDITOR: CoEditing = {
	mode: "single-editor",
	canJoin: false,
	deleted: false,
	takeOver: () => undefined,
};

describe("an entry outside a room", () => {
	it("refetches the entry when it changes somewhere else", async () => {
		const { title } = await openEntry(SINGLE_EDITOR);
		const socket = await openHub([ENTRY_TOPIC]);

		server.item = entry("Theirs");
		socket.change(ENTRY_TOPIC, { op: "update" });

		await expect.element(title).toHaveValue("Theirs");
	});

	it("keeps unsaved edits and offers the new version instead of refetching", async () => {
		const { screen, title } = await openEntry(SINGLE_EDITOR);
		const socket = await openHub([ENTRY_TOPIC]);
		await userEvent.fill(title, "Mine");
		const reads = entryReads();

		server.item = entry("Theirs");
		socket.change(ENTRY_TOPIC, { op: "update" });

		await expect.element(screen.getByText("This changed somewhere else")).toBeVisible();
		expect(entryReads()).toBe(reads);
		await expect.element(title).toHaveValue("Mine");

		await screen.getByRole("button", { name: "Load new version" }).click();

		await expect.element(title).toHaveValue("Theirs");
		expect(screen.getByText("This changed somewhere else").query()).toBeNull();
	});
});

describe("an entry in a room", () => {
	it("doesn't subscribe to the entry, whose checkpoints would refetch it under the editor", async () => {
		const fake = createRoom({ title: "First", slug: "post-one" });
		await openEntry({
			mode: "room",
			room: fake.room,
			access: "edit",
			editable: true,
			offline: false,
			unreachable: false,
			kept: null,
			reload: () => undefined,
			manifest: MANIFEST,
		});
		const socket = await openHub(["schema"]);
		expect(socket.topics()).not.toContain(ENTRY_TOPIC);
		const reads = entryReads();
		const manifestReads = server.reads["/_emdash/api/manifest"] ?? 0;

		socket.push({
			t: "changes",
			changes: [
				{ topic: ENTRY_TOPIC, op: "update", origin: "other-tab" },
				{ topic: "schema", op: "update", origin: "other-tab" },
			],
		});

		// The manifest's refetch shows the change was handled.
		await vi.waitFor(() =>
			expect(server.reads["/_emdash/api/manifest"] ?? 0).toBeGreaterThan(manifestReads),
		);
		expect(entryReads()).toBe(reads);
	});
});
