import { Role } from "@emdash-cms/auth";
import { describe, expect, it } from "vitest";

import {
	Hub,
	SILENT_HUB_SOCKET_MS,
	type HubSocket,
	type HubSocketState,
} from "../../../src/realtime/hub.js";
import { CONNECTION_LIFETIME_MS } from "../../../src/rooms/limits.js";
import type { RoomTokenClaims } from "../../../src/rooms/token.js";
import { HUB_NAME } from "../../../src/rooms/types.js";
import { CLOSE_CODES } from "../../../src/rooms/types.js";

class FakeSocket implements HubSocket {
	readonly frames: unknown[] = [];
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
	return {
		hub,
		ticket,
		connect,
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

			expect(hub.admit(used)).toMatchObject({ v: 1, userId: "ana", role: Role.EDITOR, topics: [] });
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

			expect(list.frames).toEqual([
				{
					t: "changes",
					changes: [
						{ topic: "content/posts/01A", op: "update", origin: "tab-1" },
						{ topic: "content/posts/01B", op: "create" },
					],
				},
			]);
			expect(entry.frames).toEqual([
				{ t: "changes", changes: [{ topic: "content/posts/01A", op: "update", origin: "tab-1" }] },
			]);
			expect(other.frames).toEqual([]);
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

			expect(socket.frames).toEqual([{ t: "changes", changes: [{ topic: "menus", ids: ["m1"] }] }]);
		});

		it("closes a user's sockets with rejoin when their access changes", () => {
			const { hub, connect } = setup();
			const ana = connect({}, ["users"]);
			const anaAgain = connect({}, ["content/posts"]);
			const admin = connect({ userId: "admin", role: Role.ADMIN }, ["users"]);

			hub.publish([{ topic: "users/ana", op: "update" }]);

			expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin);
			expect(anaAgain.closed?.code).toBe(CLOSE_CODES.rejoin);
			expect(ana.frames).toEqual([]);
			expect(admin.closed).toBeNull();
			expect(admin.frames).toEqual([
				{ t: "changes", changes: [{ topic: "users/ana", op: "update" }] },
			]);
		});

		it("closes sockets past their lifetime and silent ones instead of sending", () => {
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
			expect(fresh.frames).toHaveLength(1);
			expect(old.frames).toEqual([]);
			expect(silent.frames).toEqual([]);
		});
	});
});
