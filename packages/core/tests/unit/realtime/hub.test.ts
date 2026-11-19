import { Role } from "@emdash-cms/auth";
import { describe, expect, it } from "vitest";

import {
	Hub,
	RENEW_HUB_SOCKET_MS,
	SILENT_HUB_SOCKET_MS,
	readHubSocketState,
	type HubSocket,
	type HubSocketState,
	type PresencePlace,
} from "../../../src/realtime/hub.js";
import { CONNECTION_LIFETIME_MS } from "../../../src/rooms/limits.js";
import type { RoomTokenClaims } from "../../../src/rooms/token.js";
import { HUB_NAME } from "../../../src/rooms/types.js";
import { CLOSE_CODES } from "../../../src/rooms/types.js";

type Frame = { t: string; [key: string]: unknown };

class FakeSocket implements HubSocket {
	readonly frames: Frame[] = [];
	closed: { code: number; reason: string } | null = null;
	seen: number;

	constructor(
		public state: HubSocketState,
		private readonly sockets: Set<FakeSocket>,
	) {
		this.seen = state.connectedAt;
	}

	send(frame: string) {
		this.frames.push(JSON.parse(frame));
	}

	close(code: number, reason: string) {
		this.closed = { code, reason };
		this.sockets.delete(this);
	}

	save(state: HubSocketState) {
		this.state = state;
	}

	seenAt() {
		return this.seen;
	}

	changes() {
		return this.frames.filter((frame) => frame.t === "changes");
	}

	presence() {
		return this.frames.filter((frame) => frame.t === "presence");
	}

	/** Who this tab knows is at each place, from the presence frames it got. */
	roster(): Record<string, string[]> {
		const known = new Map<string, string[]>();
		for (const frame of this.presence() as Array<{ places: PresencePlace[]; all?: true }>) {
			if (frame.all) known.clear();
			for (const { topic, people } of frame.places) {
				if (people.length === 0) known.delete(topic);
				else
					known.set(
						topic,
						people.map((person) => `${person.name}:${person.activity}`),
					);
			}
		}
		return Object.fromEntries(known);
	}
}

function setup() {
	let now = 1_000_000;
	const sockets = new Set<FakeSocket>();
	const hub = new Hub({
		sockets: {
			all: () => sockets,
			ofUser: (userId) => [...sockets].filter((socket) => socket.state.userId === userId),
		},
		now: () => now,
	});
	let nonces = 0;
	const ticket = (overrides: Partial<RoomTokenClaims> = {}): RoomTokenClaims => ({
		roomId: HUB_NAME,
		userId: "ana",
		nonce: `nonce-${++nonces}`,
		expiresAt: now + 30_000,
		role: Role.EDITOR,
		name: overrides.userId ? overrides.userId[0]!.toUpperCase() + overrides.userId.slice(1) : "Ana",
		clientId: `tab-${nonces}`,
		...overrides,
	});
	const connect = (overrides: Partial<RoomTokenClaims> = {}, topics: string[] = []) => {
		const state = hub.admit(ticket(overrides));
		if (!state) throw new Error("The hub refused the ticket");
		const socket = new FakeSocket(state, sockets);
		sockets.add(socket);
		if (topics.length > 0) hub.receive(socket, JSON.stringify({ t: "topics", topics }));
		return socket;
	};
	const here = (socket: FakeSocket, topic: string | null, activity?: string) =>
		hub.receive(socket, JSON.stringify({ t: "here", topic, activity }));
	/** The host's side of a socket the tab closed. */
	const hangUp = (socket: FakeSocket) => {
		sockets.delete(socket);
		hub.left(socket.state);
	};
	return {
		hub,
		ticket,
		connect,
		here,
		hangUp,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("Hub", () => {
	describe("admit", () => {
		it("takes a ticket once", () => {
			const { hub, ticket } = setup();
			const used = ticket();

			expect(hub.admit(used)).toMatchObject({
				v: 2,
				userId: "ana",
				role: Role.EDITOR,
				topics: [],
				name: "Ana",
				here: null,
			});
			expect(hub.admit(used)).toBeNull();
		});

		it("refuses an expired ticket, a room's token and a ticket without a role", () => {
			const { hub, ticket } = setup();

			expect(hub.admit(ticket({ expiresAt: 0 }))).toBeNull();
			expect(hub.admit(ticket({ roomId: "posts:1" }))).toBeNull();
			expect(hub.admit(ticket({ role: undefined }))).toBeNull();
		});
	});

	describe("subscriptions", () => {
		it("keeps only the topics the user may subscribe to", () => {
			const { connect } = setup();

			const socket = connect({ role: Role.AUTHOR }, [
				"content/posts",
				"comments",
				"menus",
				"not-a-topic",
				"content/Bad",
				"content/posts",
			]);

			// Authors can't moderate comments.
			expect(socket.state.topics).toEqual(["content/posts", "menus"]);
		});

		it("replaces the topics with each frame and ignores frames it doesn't know", () => {
			const { hub, connect } = setup();
			const socket = connect({}, ["content/posts"]);

			hub.receive(socket, JSON.stringify({ t: "presence", place: "x" }));
			hub.receive(socket, "not json");
			expect(socket.state.topics).toEqual(["content/posts"]);

			hub.receive(socket, JSON.stringify({ t: "topics", topics: ["menus"] }));
			expect(socket.state.topics).toEqual(["menus"]);
		});

		it("closes a socket that sends a frame over the limit", () => {
			const { hub, connect } = setup();
			const socket = connect();

			hub.receive(socket, JSON.stringify({ t: "topics", topics: ["x".repeat(20_000)] }));

			expect(socket.closed?.code).toBe(1009);
		});
	});

	describe("publish", () => {
		it("sends a change to its topic's subscribers and its list's, in one frame each", () => {
			const { hub, connect } = setup();
			const list = connect({}, ["content/posts"]);
			const entry = connect({ userId: "bo" }, ["content/posts/01A"]);
			const other = connect({ userId: "cy" }, ["content/pages", "menus"]);

			hub.publish([
				{ topic: "content/posts/01A", op: "update", origin: "tab-1" },
				{ topic: "content/posts/01B", op: "create" },
			]);

			expect(list.changes()).toEqual([
				{
					t: "changes",
					changes: [
						{ topic: "content/posts/01A", op: "update", origin: "tab-1" },
						{ topic: "content/posts/01B", op: "create" },
					],
				},
			]);
			expect(entry.changes()).toEqual([
				{ t: "changes", changes: [{ topic: "content/posts/01A", op: "update", origin: "tab-1" }] },
			]);
			expect(other.changes()).toEqual([]);
		});

		it("drops changes it can't read and fields it doesn't know", () => {
			const { hub, connect } = setup();
			const socket = connect({}, ["menus"]);

			hub.publish([
				{ topic: "nope" },
				"garbage",
				{ topic: "menus", ids: ["m1"], op: "rename", extra: true },
			]);
			hub.publish({ not: "a batch" });

			expect(socket.changes()).toEqual([
				{ t: "changes", changes: [{ topic: "menus", ids: ["m1"] }] },
			]);
		});

		it("closes a user's sockets with rejoin when their access changes", () => {
			const { hub, connect } = setup();
			const ana = connect({}, ["users"]);
			const anaAgain = connect({}, ["content/posts"]);
			const admin = connect({ userId: "admin", role: Role.ADMIN }, ["users"]);

			hub.publish([{ topic: "users/ana", op: "update" }]);

			expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
			expect(anaAgain.closed?.code).toBe(CLOSE_CODES.rejoin);
			expect(ana.changes()).toEqual([]);
			expect(admin.closed).toBeNull();
			expect(admin.changes()).toEqual([
				{ t: "changes", changes: [{ topic: "users/ana", op: "update" }] },
			]);
		});

		it("closes a socket past its lifetime after sending it the change, and a silent one instead", () => {
			const { hub, connect, advance } = setup();
			const old = connect({}, ["menus"]);
			advance(CONNECTION_LIFETIME_MS - SILENT_HUB_SOCKET_MS);
			const silent = connect({ userId: "bo" }, ["menus"]);
			advance(SILENT_HUB_SOCKET_MS + 1);
			const fresh = connect({ userId: "cy" }, ["menus"]);
			old.seen = fresh.state.connectedAt;

			hub.publish([{ topic: "menus" }]);

			expect(old.closed?.code).toBe(CLOSE_CODES.rejoin);
			expect(silent.closed?.code).toBe(1001);
			expect(fresh.changes()).toHaveLength(1);
			expect(old.changes()).toEqual([{ t: "changes", changes: [{ topic: "menus" }] }]);
			expect(silent.changes()).toEqual([]);
		});

		it("hands a tab's old socket off once its new socket's topics are in effect, after earlier changes", () => {
			const { hub, connect } = setup();
			const old = connect({ clientId: "tab-a" }, ["menus"]);
			const other = connect({ userId: "bo", clientId: "tab-b" }, ["menus"]);
			const next = connect({ clientId: "tab-a" });

			hub.publish([{ topic: "menus" }]);
			hub.receive(next, JSON.stringify({ t: "topics", topics: ["menus"] }));

			expect(old.frames.map((frame) => frame.t)).toEqual(["presence", "changes", "handoff"]);
			expect(next.frames.filter((frame) => frame.t === "handoff")).toEqual([]);
			expect(other.frames.filter((frame) => frame.t === "handoff")).toEqual([]);
		});

		it("echoes a topics frame's version in its roster and in the handoff, and none for a tab that sends none", () => {
			const { hub, connect } = setup();
			const old = connect({ clientId: "tab-a" }, ["menus"]);
			const next = connect({ clientId: "tab-a" });

			hub.receive(next, JSON.stringify({ t: "topics", topics: ["menus"], v: 7 }));
			hub.receive(next, JSON.stringify({ t: "topics", topics: ["menus"] }));

			expect(next.presence().map((frame) => frame.v)).toEqual([7, undefined]);
			expect(old.frames.filter((frame) => frame.t === "handoff")).toEqual([
				{ t: "handoff", v: 7 },
				{ t: "handoff" },
			]);
		});

		it("asks a socket near the end of its lifetime to renew, once", () => {
			const { hub, connect, advance } = setup();
			const old = connect({}, ["menus"]);
			advance(CONNECTION_LIFETIME_MS - RENEW_HUB_SOCKET_MS - 1);
			const young = connect({ userId: "bo" }, ["menus"]);
			old.seen = young.state.connectedAt;

			hub.publish([{ topic: "widgets" }]);
			expect(old.frames.filter((frame) => frame.t === "renew")).toEqual([]);

			advance(1);
			old.seen = young.seen = young.state.connectedAt + 1;
			hub.publish([{ topic: "widgets" }]);
			hub.publish([{ topic: "menus" }]);

			expect(old.frames.filter((frame) => frame.t === "renew")).toHaveLength(1);
			expect(old.closed).toBeNull();
			expect(old.changes()).toHaveLength(1);
			expect(young.frames.filter((frame) => frame.t === "renew")).toEqual([]);
		});
	});

	describe("presence", () => {
		it("sends a tab's place to the subscribers of it and of the topics above it", () => {
			const { connect, here } = setup();
			const list = connect({ userId: "bo" }, ["content/posts"]);
			const entry = connect({ userId: "cy" }, ["content/posts/01A"]);
			const elsewhere = connect({ userId: "di" }, ["content/pages", "menus"]);
			const ana = connect({}, ["content/posts/01A"]);

			here(ana, "content/posts/01A", "editing");

			expect(list.roster()).toEqual({ "content/posts/01A": ["Ana:editing"] });
			expect(entry.roster()).toEqual({ "content/posts/01A": ["Ana:editing"] });
			expect(elsewhere.presence()).toEqual([{ t: "presence", places: [], all: true }]);
			expect(list.presence().at(-1)).toEqual({
				t: "presence",
				places: [
					{
						topic: "content/posts/01A",
						people: [
							{ userId: "ana", name: "Ana", clientId: ana.state.clientId, activity: "editing" },
						],
					},
				],
			});
		});

		it("gives a new subscriber everyone already under its topics", () => {
			const { connect, here } = setup();
			here(connect({}, []), "content/posts/01A", "editing");
			here(connect({ userId: "bo" }, []), "menus/main");

			const list = connect({ userId: "cy" }, ["content/posts", "menus/main"]);

			expect(list.presence()).toHaveLength(1);
			expect(list.roster()).toEqual({
				"content/posts/01A": ["Ana:editing"],
				"menus/main": ["Bo:viewing"],
			});
		});

		it("moves a tab between places and takes it off when it says it's nowhere", () => {
			const { connect, here } = setup();
			const list = connect({ userId: "bo" }, ["content/posts"]);
			const ana = connect();

			here(ana, "content/posts/01A", "editing");
			here(ana, "content/posts/01B", "viewing");
			expect(list.roster()).toEqual({ "content/posts/01B": ["Ana:viewing"] });
			expect(list.presence().at(-1)).toMatchObject({
				places: [
					{ topic: "content/posts/01A", people: [] },
					{ topic: "content/posts/01B", people: [{ name: "Ana" }] },
				],
			});

			here(ana, null);
			expect(list.roster()).toEqual({});
			expect(ana.state.here).toBeNull();
		});

		it("sends nothing when a tab repeats its place", () => {
			const { connect, here } = setup();
			const list = connect({ userId: "bo" }, ["menus"]);
			const ana = connect();
			here(ana, "menus/main");
			const sent = list.frames.length;

			here(ana, "menus/main", "viewing");

			expect(list.frames).toHaveLength(sent);
		});

		it("takes a tab off its place's roster when its socket closes", () => {
			const { connect, here, hangUp } = setup();
			const list = connect({ userId: "bo" }, ["menus"]);
			const ana = connect();
			const anaAgain = connect();
			here(ana, "menus/main", "editing");
			here(anaAgain, "menus/main");
			expect(list.roster()).toEqual({ "menus/main": ["Ana:editing", "Ana:viewing"] });

			hangUp(ana);

			expect(list.roster()).toEqual({ "menus/main": ["Ana:viewing"] });
		});

		it("takes a tab off when the hub closes its socket", () => {
			const { hub, connect, here, advance } = setup();
			const ana = connect();
			here(ana, "menus/main");
			advance(CONNECTION_LIFETIME_MS - 1);
			ana.seen = ana.state.connectedAt + CONNECTION_LIFETIME_MS - 1;
			const list = connect({ userId: "bo" }, ["menus"]);
			expect(list.roster()).toEqual({ "menus/main": ["Ana:viewing"] });
			advance(1);
			list.seen = list.state.connectedAt + 1;

			hub.publish([{ topic: "menus" }]);

			expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
			expect(list.roster()).toEqual({});
		});

		it("leaves out a silent tab that is still at a place", () => {
			const { connect, here, advance } = setup();
			here(connect(), "menus/main");
			advance(SILENT_HUB_SOCKET_MS + 1);

			const list = connect({ userId: "bo" }, ["menus"]);

			expect(list.roster()).toEqual({});
		});

		it("shows a place only to sockets whose role may subscribe to it", () => {
			const { connect, here } = setup();
			const author = connect({ userId: "bo", role: Role.AUTHOR }, ["comments", "users"]);
			const admin = connect({ userId: "admin", role: Role.ADMIN }, ["comments", "users"]);
			const editor = connect({ role: Role.EDITOR });

			here(editor, "comments");
			here(editor, "users/01USER");

			expect(author.state.topics).toEqual([]);
			expect(author.roster()).toEqual({});
			// An editor can't see users, so they can't announce a place there either.
			expect(admin.roster()).toEqual({ comments: ["Ana:viewing"] });
			expect(editor.state.here).toEqual({ topic: "comments", activity: "viewing" });
		});

		it("rechecks the receiver's role when a roster goes out", () => {
			const { connect, here } = setup();
			const author = connect({ userId: "bo", role: Role.AUTHOR }, ["comments"]);
			author.state = { ...author.state, topics: ["comments"] };

			here(connect({ role: Role.ADMIN }), "comments");

			expect(author.presence().at(-1)).toEqual({ t: "presence", places: [], all: true });
		});

		it("ignores a place from a socket whose ticket has no name or tab", () => {
			const { connect, here } = setup();
			const list = connect({ userId: "bo" }, ["menus"]);
			const nameless = connect({ name: undefined });
			const tabless = connect({ userId: "cy", clientId: undefined });

			here(nameless, "menus/main");
			here(tabless, "menus/main");
			here(connect({ userId: "di" }), "menus/main", "dancing");

			expect(list.roster()).toEqual({});
		});

		it("keeps a socket's state under what an attachment holds", () => {
			const { connect } = setup();

			const socket = connect(
				{},
				Array.from({ length: 32 }, (_, i) => `content/c${i}${"x".repeat(110)}/${"界".repeat(128)}`),
			);

			expect(socket.state.topics.length).toBeGreaterThan(0);
			expect(socket.state.topics.length).toBeLessThan(32);
		});
	});

	describe("plugin channels", () => {
		const channels = {
			"forms/submissions": "settings:read",
			"forms/audit": "plugins:manage",
			"%40acme%2Fqueue/jobs": "content:read_drafts",
			"forms/bogus": "not:a-permission",
		};

		it("lets a socket subscribe only to channels whose permission its role has", () => {
			const { connect } = setup();

			const editor = connect({ role: Role.EDITOR, channels }, [
				"plugin/forms/submissions",
				"plugin/forms/submissions/42",
				"plugin/forms/audit",
				"plugin/%40acme%2Fqueue/jobs",
				"plugin/forms/bogus",
				"plugin/forms/undeclared",
			]);
			const admin = connect({ userId: "bo", role: Role.ADMIN, channels }, ["plugin/forms/audit"]);
			const author = connect({ userId: "cy", role: Role.AUTHOR, channels }, [
				"plugin/forms/submissions",
				"plugin/%40acme%2Fqueue/jobs",
			]);

			expect(editor.state.topics).toEqual([
				"plugin/forms/submissions",
				"plugin/forms/submissions/42",
				"plugin/%40acme%2Fqueue/jobs",
			]);
			expect(admin.state.topics).toEqual(["plugin/forms/audit"]);
			expect(author.state.topics).toEqual(["plugin/%40acme%2Fqueue/jobs"]);
		});

		it("refuses every plugin channel to a ticket that carries no permissions", () => {
			const { connect } = setup();

			const socket = connect({ role: Role.ADMIN }, ["plugin/forms/submissions"]);

			expect(socket.state.topics).toEqual([]);
		});

		it("sends a plugin's change only to the sockets allowed its channel, bubbling to it", () => {
			const { hub, connect } = setup();
			const editor = connect({ role: Role.EDITOR, channels }, ["plugin/forms/submissions"]);
			const author = connect({ userId: "cy", role: Role.AUTHOR, channels }, [
				"plugin/forms/submissions",
			]);

			hub.publish([{ topic: "plugin/forms/submissions/42", op: "create" }]);

			expect(editor.changes()).toEqual([
				{ t: "changes", changes: [{ topic: "plugin/forms/submissions/42", op: "create" }] },
			]);
			expect(author.changes()).toEqual([]);
		});

		it("shows who is at a plugin channel only to sockets allowed it", () => {
			const { connect, here } = setup();
			const ana = connect({ role: Role.EDITOR, channels }, ["plugin/forms/submissions"]);
			const author = connect({ userId: "cy", role: Role.AUTHOR, channels }, [
				"plugin/forms/submissions",
			]);
			const bo = connect({ userId: "bo", role: Role.EDITOR, channels }, [
				"plugin/forms/submissions",
			]);

			here(bo, "plugin/forms/submissions/42", "editing");
			here(author, "plugin/forms/submissions/42", "editing");

			expect(ana.roster()).toEqual({ "plugin/forms/submissions/42": ["Bo:editing"] });
			expect(author.roster()).toEqual({});
		});
	});

	describe("readHubSocketState", () => {
		it("reads a state from before presence as one that can't announce", () => {
			expect(
				readHubSocketState({
					v: 1,
					userId: "ana",
					role: Role.EDITOR,
					connectedAt: 1,
					topics: ["menus"],
				}),
			).toEqual({
				v: 2,
				userId: "ana",
				role: Role.EDITOR,
				connectedAt: 1,
				topics: ["menus"],
				name: "",
				clientId: null,
				here: null,
				channels: [],
			});
		});

		it("reads a state without plugin channels as one that has none", () => {
			const state = readHubSocketState({
				v: 2,
				userId: "ana",
				role: Role.EDITOR,
				connectedAt: 1,
				topics: [],
				name: "Ana",
				clientId: "tab-1",
				here: null,
			});

			expect(state?.channels).toEqual([]);
		});

		it("refuses a state from a newer hub or one it can't read", () => {
			expect(readHubSocketState({ v: 3, userId: "ana" })).toBeNull();
			expect(readHubSocketState(null)).toBeNull();
		});
	});
});
