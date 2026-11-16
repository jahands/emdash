import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { LiveSyncProvider } from "../../src/lib/realtime/LiveSyncProvider";
import { TAB_ID } from "../../src/lib/realtime/tab-id";
import { contentListQuery, menusQueryOptions } from "../../src/lib/route-queries";
import { pagedQueryOptions } from "../../src/lib/use-paged-query";
import { createTestQueryClient } from "../utils/test-helpers";

/** A hub socket the test plays the server's side of. */
class FakeSocket extends EventTarget {
	static readonly OPEN = 1;
	static instances: FakeSocket[] = [];
	readyState = 0;
	readonly sent: string[] = [];

	constructor(readonly url: string) {
		super();
		FakeSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(code = 1000) {
		this.drop(code);
	}

	open() {
		this.readyState = FakeSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	push(frame: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}

	drop(code: number) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.dispatchEvent(new CloseEvent("close", { code }));
	}

	/** The topics the last frame subscribed to. */
	topics(): string[] {
		for (const data of this.sent.toReversed()) {
			const frame = JSON.parse(data) as { t: string; topics?: string[] };
			if (frame.t === "topics") return frame.topics ?? [];
		}
		return [];
	}
}

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

	beforeEach(() => {
		FakeSocket.instances = [];
		reads.menus = 0;
		reads.posts = 0;
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

	it("reconnects after the socket drops, and refetches what it may have missed", async () => {
		const socket = await connect();

		socket.drop(1006);

		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
		FakeSocket.instances[1]!.open();
		await vi.waitFor(() => expect(reads).toEqual({ menus: 2, posts: 2 }));
		expect(FakeSocket.instances[1]!.topics()).toEqual(["content/posts", "menus"]);
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
