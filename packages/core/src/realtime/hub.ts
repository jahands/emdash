/**
 * The realtime hub, `emdash/internal/realtime/hub`: one per site, telling each admin tab which of
 * its topics changed. Everything it knows lives in its sockets, in each one's attachment and tags
 * on Cloudflare, so a hub that outlived its memory rebuilds from them. It keeps no timers and no
 * storage, which would stop a Durable Object from hibernating: connection lifetime and silence
 * are checked when it publishes.
 */

import type { RoleLevel } from "@emdash-cms/auth";

import { CONNECTION_LIFETIME_MS } from "../rooms/limits.js";
import type { RoomTokenClaims } from "../rooms/token.js";
import { CLOSE_CODES } from "../rooms/types.js";
import { HUB_NAME } from "./path.js";
import type { Change, ChangeOp } from "./publish.js";
import { maySubscribe, parseTopic, topicAndAncestors } from "./topics.js";

/** Far under the 16 KiB a Durable Object keeps per socket, with every topic at its longest. */
export const MAX_HUB_TOPICS = 32;
export const MAX_HUB_MESSAGE_BYTES = 16 * 1024;
/**
 * Tabs ping every 30 s, but browsers run a hidden tab's timers only about once a minute, so a
 * socket silent this long is gone.
 */
export const SILENT_HUB_SOCKET_MS = 3 * 60 * 1000;
const MAX_IDS = 50;
const GOING_AWAY = 1001;
const MESSAGE_TOO_BIG = 1009;
const OPS: ReadonlySet<string> = new Set<ChangeOp>(["create", "update", "delete"]);

/** What a socket keeps through hibernation. Plain data, so it fits an attachment. */
export interface HubSocketState {
	/** Hub code reads attachments that older code wrote, so the shape is versioned. */
	v: 1;
	userId: string;
	role: RoleLevel;
	connectedAt: number;
	topics: string[];
}

/** A socket, from the host. */
export interface HubSocket {
	readonly state: HubSocketState;
	send(frame: string): void;
	/** Afterwards the host leaves the socket out of `all` and `ofUser`. */
	close(code: number, reason: string): void;
	/** Keeps a new state through hibernation. */
	save(state: HubSocketState): void;
	/** When the socket last showed it is alive, in ms. */
	seenAt(): number;
}

/** The host's open sockets. */
export interface HubSockets {
	all(): Iterable<HubSocket>;
	ofUser(userId: string): Iterable<HubSocket>;
}

export type ClientFrame = { t: "topics"; topics: string[] };
export type HubFrame = { t: "changes"; changes: Change[] };

export interface HubOptions {
	sockets: HubSockets;
	now?: () => number;
}

export class Hub {
	readonly #sockets: HubSockets;
	readonly #now: () => number;
	/** Used tickets' nonces, until they expire. Lost with the hub's memory. */
	readonly #used = new Map<string, number>();

	constructor(options: HubOptions) {
		this.#sockets = options.sockets;
		this.#now = options.now ?? Date.now;
	}

	/**
	 * The state of a new socket whose ticket a host verified, or null when the ticket isn't the
	 * hub's, has expired, or was used.
	 */
	admit(ticket: RoomTokenClaims): HubSocketState | null {
		const now = this.#now();
		for (const [nonce, expiresAt] of this.#used) {
			if (expiresAt <= now) this.#used.delete(nonce);
		}
		if (ticket.roomId !== HUB_NAME || ticket.role === undefined) return null;
		if (ticket.expiresAt <= now || this.#used.has(ticket.nonce)) return null;
		this.#used.set(ticket.nonce, ticket.expiresAt);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the ticket route signs the user's role level
		const role = ticket.role as RoleLevel;
		return { v: 1, userId: ticket.userId, role, connectedAt: now, topics: [] };
	}

	/** A text frame from a tab. Sets the socket's topics to the ones it may subscribe to. */
	receive(socket: HubSocket, message: string): void {
		if (new TextEncoder().encode(message).byteLength > MAX_HUB_MESSAGE_BYTES) {
			socket.close(MESSAGE_TOO_BIG, "The message is too big");
			return;
		}
		if (!this.#live(socket, this.#now())) return;
		let frame: unknown;
		try {
			frame = JSON.parse(message);
		} catch {
			return;
		}
		if (!isTopicsFrame(frame)) return;
		const topics = [...new Set(frame.topics.filter((topic) => typeof topic === "string"))]
			.filter((topic) => maySubscribe(socket.state.role, topic))
			.slice(0, MAX_HUB_TOPICS);
		socket.save({ ...socket.state, topics });
	}

	/**
	 * Sends each socket one frame with the changes to its topics. A change to `users/{id}` first
	 * closes that user's sockets with `rejoin`, so a new ticket rechecks their access. Fields this
	 * hub doesn't know are dropped, so a newer Worker can call an older hub.
	 */
	publish(batch: unknown): void {
		const changes = readChanges(batch);
		if (changes.length === 0) return;
		const closed = new Set<HubSocket>();
		for (const change of changes) {
			const topic = parseTopic(change.topic);
			if (topic?.namespace !== "users" || topic.keys.length !== 1) continue;
			for (const socket of this.#sockets.ofUser(topic.keys[0])) {
				socket.close(CLOSE_CODES.rejoin, "The user's access changed");
				closed.add(socket);
			}
		}
		const now = this.#now();
		const reaches = changes.map((change) => topicAndAncestors(change.topic));
		for (const socket of this.#sockets.all()) {
			if (closed.has(socket) || !this.#live(socket, now)) continue;
			const { topics } = socket.state;
			const matching = changes.filter((_, index) =>
				reaches[index].some((topic) => topics.includes(topic)),
			);
			if (matching.length === 0) continue;
			const frame: HubFrame = { t: "changes", changes: matching };
			socket.send(JSON.stringify(frame));
		}
	}

	/** Closes a socket past its lifetime or gone silent. */
	#live(socket: HubSocket, now: number): boolean {
		if (now - socket.state.connectedAt >= CONNECTION_LIFETIME_MS) {
			socket.close(CLOSE_CODES.rejoin, "The connection reached its lifetime");
			return false;
		}
		if (now - socket.seenAt() > SILENT_HUB_SOCKET_MS) {
			socket.close(GOING_AWAY, "The connection went silent");
			return false;
		}
		return true;
	}
}

/** Whether an attachment is a socket state this code reads. */
export function isHubSocketState(value: unknown): value is HubSocketState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<HubSocketState>;
	return (
		state.v === 1 &&
		typeof state.userId === "string" &&
		typeof state.role === "number" &&
		typeof state.connectedAt === "number" &&
		Array.isArray(state.topics)
	);
}

function isTopicsFrame(frame: unknown): frame is { t: "topics"; topics: unknown[] } {
	return (
		typeof frame === "object" &&
		frame !== null &&
		"t" in frame &&
		frame.t === "topics" &&
		"topics" in frame &&
		Array.isArray(frame.topics)
	);
}

function isOp(op: unknown): op is ChangeOp {
	return typeof op === "string" && OPS.has(op);
}

function readChanges(batch: unknown): Change[] {
	if (!Array.isArray(batch)) return [];
	const changes: Change[] = [];
	for (const item of batch) {
		if (typeof item !== "object" || item === null || !("topic" in item)) continue;
		const { topic } = item;
		if (typeof topic !== "string" || !parseTopic(topic)) continue;
		const change: Change = { topic };
		const ids = "ids" in item ? item.ids : undefined;
		if (Array.isArray(ids) && ids.length <= MAX_IDS && ids.every((id) => typeof id === "string")) {
			change.ids = ids;
		}
		const op = "op" in item ? item.op : undefined;
		if (isOp(op)) change.op = op;
		const origin = "origin" in item ? item.origin : undefined;
		if (typeof origin === "string" && origin.length <= 64) change.origin = origin;
		changes.push(change);
	}
	return changes;
}
