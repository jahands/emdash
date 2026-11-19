import {
	focusManager,
	QueryClientProvider,
	useInfiniteQuery,
	useQuery,
	type QueryClient,
} from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { LiveSyncProvider, useLiveQueries } from "../../src/lib/realtime/LiveSyncProvider";
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
	/** The socket lifetime tickets carry, or none, as hubs from before it send. */
	let ticketLifetime: number | undefined;

	beforeEach(() => {
		FakeSocket.instances = [];
		reads.menus = 0;
		reads.posts = 0;
		postsGate = null;
		ticketLifetime = undefined;
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const json = (data: unknown) =>
				new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });
			if (url.endsWith("/_emdash/api/realtime") && init?.method === "POST") {
				return json({
					mode: "live",
					url: "/_emdash/api/realtime",
					ticket: "ticket-1",
					lifetime: ticketLifetime,
				});
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

	it("waits out the throttle after a read that was running when a change arrived", async () => {
		const socket = await connect();
		const starts: number[] = [];
		const counted = reads.posts;
		let release = () => {};
		postsGate = new Promise((resolve) => (release = resolve));
		void queryClient.refetchQueries({ queryKey: LIST.scope });
		await vi.waitFor(() => expect(reads.posts).toBe(counted + 1));
		starts.push(Date.now());

		socket.change("content/posts", { op: "create" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		postsGate = null;
		release();
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(reads.posts).toBe(counted + 1);

		await vi.waitFor(() => expect(reads.posts).toBe(counted + 2), { timeout: 3000 });
		expect(Date.now() - starts[0]!).toBeGreaterThanOrEqual(1900);
	});

	it("throttles a screen's registered queries from their last read like any other", async () => {
		function Editor() {
			useQuery(menusQueryOptions(undefined));
			useLiveQueries({ topics: ["widgets"], queryKeys: [["menus"]], dirty: false });
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Editor />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["menus", "widgets"]));
		await vi.waitFor(() => expect(reads.menus).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const read = Date.now();
		await queryClient.refetchQueries({ queryKey: ["menus"] });
		expect(reads.menus).toBe(2);

		socket.change("widgets");
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(reads.menus).toBe(2);
		await vi.waitFor(() => expect(reads.menus).toBe(3), { timeout: 3000 });
		expect(Date.now() - read).toBeGreaterThanOrEqual(1900);
	});

	it("drops a change queued for one entry when the screen moves on to another", async () => {
		const entryReads: string[] = [];
		let show: (id: string, dirty: boolean) => void = () => {};
		function Entry() {
			const [state, setState] = React.useState({ id: "a", dirty: false });
			show = (id, dirty) => setState({ id, dirty });
			useQuery({
				queryKey: ["entry", state.id],
				queryFn: () => {
					entryReads.push(state.id);
					return Promise.resolve(state.id);
				},
			});
			const live = useLiveQueries({
				topics: [`content/posts/${state.id}`],
				queryKeys: [["entry", state.id]],
				dirty: state.dirty,
			});
			return <output>{live.changedElsewhere ? "Changed elsewhere" : "Current"}</output>;
		}
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Entry />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["content/posts/a"]));
		socket.change("content/posts/a", { op: "update" });
		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a"]));
		socket.change("content/posts/a", { op: "update" });

		show("b", true);
		await new Promise((resolve) => setTimeout(resolve, 2500));

		expect(screen.container.textContent).toBe("Current");
	});

	it("reads an entry again on return when a change for it was still queued as the screen left", async () => {
		const entryReads: string[] = [];
		let show: (id: string) => void = () => {};
		function Entry() {
			const [id, setId] = React.useState("a");
			show = setId;
			useQuery({
				queryKey: ["entry", id],
				queryFn: () => {
					entryReads.push(id);
					return Promise.resolve(id);
				},
				staleTime: 60_000,
				gcTime: 60_000,
			});
			useLiveQueries({ topics: [`content/posts/${id}`], queryKeys: [["entry", id]], dirty: false });
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Entry />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["content/posts/a"]));
		socket.change("content/posts/a", { op: "update" });
		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a"]));
		socket.change("content/posts/a", { op: "update" });

		show("b");
		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a", "b"]));
		show("a");

		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a", "b", "a"]));
	});

	it("reads an entry again on return when the screen leaves it with a change held under edits", async () => {
		const entryReads: string[] = [];
		let show: (id: string, dirty: boolean) => void = () => {};
		function Entry() {
			const [state, setState] = React.useState({ id: "a", dirty: false });
			show = (id, dirty) => setState({ id, dirty });
			useQuery({
				queryKey: ["entry", state.id],
				queryFn: () => {
					entryReads.push(state.id);
					return Promise.resolve(state.id);
				},
				staleTime: 60_000,
				gcTime: 60_000,
			});
			useLiveQueries({
				topics: [`content/posts/${state.id}`],
				queryKeys: [["entry", state.id]],
				dirty: state.dirty,
			});
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Entry />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["content/posts/a"]));
		show("a", true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		socket.change("content/posts/a", { op: "update" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(entryReads).toEqual(["a"]);

		show("b", false);
		await vi.waitFor(() => expect(entryReads).toEqual(["a", "b"]));
		show("a", false);

		await vi.waitFor(() => expect(entryReads).toEqual(["a", "b", "a"]));
	});

	it("reads an entry again on return when an older read finished after the screen left it", async () => {
		const entryReads: string[] = [];
		let releaseA = () => {};
		let holdA = false;
		let show: (id: string) => void = () => {};
		function Entry() {
			const [id, setId] = React.useState("a");
			show = setId;
			useQuery({
				queryKey: ["entry", id],
				queryFn: async () => {
					entryReads.push(id);
					if (id === "a" && holdA) {
						holdA = false;
						await new Promise<void>((resolve) => (releaseA = resolve));
					}
					return id;
				},
				staleTime: 60_000,
				gcTime: 60_000,
			});
			useLiveQueries({ topics: [`content/posts/${id}`], queryKeys: [["entry", id]], dirty: false });
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Entry />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["content/posts/a"]));
		holdA = true;
		socket.change("content/posts/a", { op: "update" });
		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a"]));
		socket.change("content/posts/a", { op: "update" });

		show("b");
		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a", "b"]));
		releaseA();
		await new Promise((resolve) => setTimeout(resolve, 50));
		show("a");

		await vi.waitFor(() => expect(entryReads).toEqual(["a", "a", "b", "a"]));
	});

	it("keeps a held change queued when the save's own read fails", async () => {
		let settingsReads = 0;
		let failNext = false;
		let setDirty: (dirty: boolean) => void = () => {};
		function Settings() {
			const [dirty, setState] = React.useState(true);
			setDirty = setState;
			useQuery({
				queryKey: ["settings-form"],
				queryFn: async () => {
					settingsReads++;
					if (failNext) {
						failNext = false;
						// Still running when the caught-up change comes due, two seconds on.
						await new Promise((resolve) => setTimeout(resolve, 2500));
						throw new Error("offline");
					}
					return {};
				},
			});
			useLiveQueries({ topics: ["settings"], queryKeys: [["settings-form"]], dirty });
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Settings />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["settings"]));
		await vi.waitFor(() => expect(settingsReads).toBe(1));
		socket.change("settings");
		await new Promise((resolve) => setTimeout(resolve, 50));

		failNext = true;
		void queryClient.invalidateQueries({ queryKey: ["settings-form"] }).catch(() => undefined);
		setDirty(false);

		await vi.waitFor(() => expect(settingsReads).toBe(3), { timeout: 6000 });
	});

	it("keeps a held change queued while the save's read waits to retry in a hidden tab", async () => {
		let settingsReads = 0;
		let failures = 0;
		let setDirty: (dirty: boolean) => void = () => {};
		function Settings() {
			const [dirty, setState] = React.useState(true);
			setDirty = setState;
			useQuery({
				queryKey: ["settings-form"],
				queryFn: async () => {
					settingsReads++;
					if (failures > 0) {
						failures--;
						throw new Error("offline");
					}
					return {};
				},
				retry: 1,
				retryDelay: 10,
			});
			useLiveQueries({ topics: ["settings"], queryKeys: [["settings-form"]], dirty });
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Settings />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["settings"]));
		await vi.waitFor(() => expect(settingsReads).toBe(1));
		socket.change("settings");
		await new Promise((resolve) => setTimeout(resolve, 50));

		try {
			failures = 2;
			focusManager.setFocused(false);
			void queryClient.invalidateQueries({ queryKey: ["settings-form"] }).catch(() => undefined);
			await vi.waitFor(() =>
				expect(queryClient.getQueryState(["settings-form"])?.fetchStatus).toBe("paused"),
			);
			setDirty(false);
			await new Promise((resolve) => setTimeout(resolve, 2500));
		} finally {
			focusManager.setFocused(undefined);
		}

		await vi.waitFor(() => expect(settingsReads).toBe(4), { timeout: 4000 });
	});

	it("lets the save's own read cover a change held under unsaved edits", async () => {
		let settingsReads = 0;
		let setDirty: (dirty: boolean) => void = () => {};
		function Settings() {
			const [dirty, setState] = React.useState(true);
			setDirty = setState;
			useQuery({
				queryKey: ["settings-form"],
				queryFn: () => {
					settingsReads++;
					return Promise.resolve({});
				},
			});
			const live = useLiveQueries({ topics: ["settings"], queryKeys: [["settings-form"]], dirty });
			return <output>{live.changedElsewhere ? "Changed elsewhere" : "Current"}</output>;
		}
		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Settings />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["settings"]));
		await vi.waitFor(() => expect(settingsReads).toBe(1));
		socket.change("settings");
		await vi.waitFor(() => expect(screen.container.textContent).toBe("Changed elsewhere"));
		await new Promise((resolve) => setTimeout(resolve, 20));

		await queryClient.invalidateQueries({ queryKey: ["settings-form"] });
		setDirty(false);
		expect(settingsReads).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 2500));

		expect(settingsReads).toBe(2);
		expect(screen.container.textContent).toBe("Current");
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

	it("reconnects after the socket drops, and refetches what it may have missed once the hub has its topics", async () => {
		const socket = await connect();

		socket.drop(1006);

		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
		const next = FakeSocket.instances[1]!;
		next.open();
		expect(next.topics()).toEqual(["content/posts", "menus"]);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reads).toEqual({ menus: 1, posts: 1 });

		next.presence([], true);
		await vi.waitFor(() => expect(reads).toEqual({ menus: 2, posts: 2 }));
	});

	it("refetches on reconnect what the tab read while the socket was down", async () => {
		const socket = await connect();

		socket.drop(1006);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await queryClient.refetchQueries({ queryKey: ["menus"] });
		expect(reads).toEqual({ menus: 2, posts: 1 });

		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
		FakeSocket.instances[1]!.open();
		FakeSocket.instances[1]!.presence([], true);
		// The menus refetch waits out the throttle from the read above.
		await vi.waitFor(() => expect(reads).toEqual({ menus: 3, posts: 2 }), { timeout: 3000 });
	});

	it("moves to a new socket once the hub hands the old one off, without refetching", async () => {
		const socket = await connect();
		vi.spyOn(Math, "random").mockReturnValue(0);

		socket.push({ t: "renew" });
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
		const next = FakeSocket.instances[1]!;
		next.open();
		expect(next.topics()).toEqual(["content/posts", "menus"]);
		next.presence([], true);
		expect(socket.readyState).toBe(FakeSocket.OPEN);

		// Sent to the old socket before the handoff, so the new one never got it.
		socket.change("menus");
		await vi.waitFor(() => expect(reads.menus).toBe(2));
		socket.push({ t: "handoff", v: next.topicsVersion() });
		expect(socket.readyState).toBe(3);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(reads).toEqual({ menus: 2, posts: 1 });
		expect(FakeSocket.instances).toHaveLength(2);

		// Within the throttle window of the refetch above.
		next.change("menus");
		await vi.waitFor(() => expect(reads.menus).toBe(3), { timeout: 3000 });
	});

	it("moves over and refetches when a hub that never hands off has the new socket's topics", async () => {
		const socket = await connect();
		vi.spyOn(Math, "random").mockReturnValue(0);

		socket.push({ t: "renew" });
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
		const next = FakeSocket.instances[1]!;
		next.open();
		next.presence([], true);

		await vi.waitFor(() => expect(socket.readyState).toBe(3), { timeout: 7000 });
		await vi.waitFor(() => expect(reads).toEqual({ menus: 2, posts: 2 }));
	});

	it("spreads the renewals the hub asks for over the socket's last minute", async () => {
		const socket = await connect();
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		socket.push({ t: "renew" });

		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it("renews its socket itself before the lifetime the ticket gives, on a quiet hub", async () => {
		ticketLifetime = 61_000;
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		await connect();

		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2), { timeout: 3000 });
	});

	it("refetches the pages it has when a change arrives before it loads another one", async () => {
		const firstPageReads: number[] = [];
		let loadMore = () => {};
		function Inbox() {
			const query = useInfiniteQuery({
				queryKey: ["inbox"],
				queryFn: ({ pageParam }) => {
					if (pageParam === 0) firstPageReads.push(Date.now());
					return Promise.resolve({ page: pageParam });
				},
				initialPageParam: 0,
				getNextPageParam: (last) => last.page + 1,
				meta: { live: ["comments"] },
			});
			loadMore = () => void query.fetchNextPage();
			return null;
		}
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<Inbox />
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(socket.topics()).toEqual(["comments"]));
		socket.change("comments");
		await vi.waitFor(() => expect(firstPageReads).toHaveLength(2));

		socket.change("comments");
		await new Promise((resolve) => setTimeout(resolve, 50));
		loadMore();
		await vi.waitFor(() => expect(firstPageReads).toHaveLength(3), { timeout: 4000 });
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
