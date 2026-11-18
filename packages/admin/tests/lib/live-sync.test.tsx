import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { LiveSyncProvider } from "../../src/lib/realtime/LiveSyncProvider";
import { TAB_ID } from "../../src/lib/realtime/tab-id";
import { contentListQuery, menusQueryOptions } from "../../src/lib/route-queries";
import { pagedQueryOptions } from "../../src/lib/use-paged-query";
import { FakeSocket } from "../utils/fake-hub";
import { createTestQueryClient } from "../utils/test-helpers";

const LIST = contentListQuery("posts", {
	locale: undefined,
	sort: { field: "updatedAt", direction: "desc" },
	search: "",
	status: "all",
	author: "",
	date: undefined,
	byline: undefined,
	fields: undefined,
});

function Screen() {
	useQuery(menusQueryOptions(undefined));
	useQuery(pagedQueryOptions(LIST, 1, 20));
	return null;
}

describe("LiveSyncProvider", () => {
	let queryClient: QueryClient;
	const reads = { menus: 0, posts: 0 };
	/** While set, list reads wait for it, as a slow server would. */
	let postsGate: Promise<void> | null = null;

	beforeEach(() => {
		FakeSocket.instances = [];
		reads.menus = 0;
		reads.posts = 0;
		postsGate = null;
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const json = (data: unknown) =>
				new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
			if (url.endsWith("/_emdash/api/realtime") && init?.method === "POST") {
				return json({ mode: "live", url: "/_emdash/api/realtime", ticket: "ticket-1" });
			}
			if (url.includes("/_emdash/api/menus")) {
				reads.menus++;
				return json([]);
			}
			if (url.includes("/_emdash/api/content/posts")) {
				reads.posts++;
				await postsGate;
				return json({ items: [], total: 0 });
			}
			return new Response(null, { status: 404 });
		});
		queryClient = createTestQueryClient();
	});

	afterEach(() => {
		queryClient.clear();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function connect(): Promise<FakeSocket> {
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Screen />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		expect(new URL(socket.url).searchParams.get("token")).toBe("ticket-1");
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["content/posts", "menus"]));
		await vi.waitFor(() => expect(reads).toEqual({ menus: 1, posts: 1 }));
		return socket;
	}

	it("refetches a list when another client changes it, and not for the tab's own change", async () => {
		const socket = await connect();

		socket.push({ t: "changes", changes: [{ topic: "menus", ids: ["m1"], origin: TAB_ID }] });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reads).toEqual({ menus: 1, posts: 1 });

		socket.push({ t: "changes", changes: [{ topic: "menus", ids: ["m1"], origin: "other-tab" }] });
		await vi.waitFor(() => expect(reads.menus).toBe(2));
		expect(reads.posts).toBe(1);
	});

	it("refetches a collection's list when one of its entries changes", async () => {
		const socket = await connect();

		socket.push({ t: "changes", changes: [{ topic: "content/posts/01A", op: "update" }] });

		await vi.waitFor(() => expect(reads.posts).toBe(2));
		expect(reads.menus).toBe(1);
	});

	it("refetches a list less often for its entries' updates than for entries added or removed", async () => {
		const socket = await connect();

		socket.change("content/posts/01A", { op: "update" });
		await vi.waitFor(() => expect(reads.posts).toBe(2));
		await new Promise((resolve) => setTimeout(resolve, 2300));
		socket.change("content/posts/01A", { op: "update" });
		await new Promise((resolve) => setTimeout(resolve, 2300));
		expect(reads.posts).toBe(2);

		socket.change("content/posts/01B", { op: "create" });
		await vi.waitFor(() => expect(reads.posts).toBe(3));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reads).toEqual({ menus: 1, posts: 3 });
	});

	it("lets a slow refetch finish, then refetches once for the changes that arrived during it", async () => {
		const socket = await connect();
		let release = () => {};
		postsGate = new Promise((resolve) => (release = resolve));

		socket.change("content/posts", { op: "create" });
		await vi.waitFor(() => expect(reads.posts).toBe(2));
		socket.change("content/posts", { op: "create" });
		await new Promise((resolve) => setTimeout(resolve, 2300));
		socket.change("content/posts", { op: "create" });
		await new Promise((resolve) => setTimeout(resolve, 2300));
		expect(reads.posts).toBe(2);

		postsGate = null;
		release();
		await vi.waitFor(() => expect(reads.posts).toBe(3));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reads.posts).toBe(3);
	});

	it("reconnects after the socket drops, and refetches what it may have missed", async () => {
		const socket = await connect();

		socket.drop(1006);

		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
		FakeSocket.instances[1]!.open();
		await vi.waitFor(() => expect(reads).toEqual({ menus: 2, posts: 2 }));
		expect(FakeSocket.instances[1]!.topics()).toEqual(["content/posts", "menus"]);
	});

	it("doesn't refetch on reconnect what the tab already refetched since the socket dropped", async () => {
		const socket = await connect();

		socket.drop(1006);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await queryClient.refetchQueries({ queryKey: ["menus"] });
		expect(reads).toEqual({ menus: 2, posts: 1 });

		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
		FakeSocket.instances[1]!.open();
		await vi.waitFor(() => expect(reads.posts).toBe(2));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reads.menus).toBe(2);
	});

	it("opens no socket when the host runs no hub", async () => {
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled={false}>
					<Screen />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(reads).toEqual({ menus: 1, posts: 1 }));

		expect(FakeSocket.instances).toHaveLength(0);
	});
});
