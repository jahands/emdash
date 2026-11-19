/**
 * The realtime hub, `emdash/internal/realtime/hub`: one per site, telling each admin tab which of
 * its topics changed and who else is where. Everything it knows lives in its sockets, in each
 * one's attachment and tags on Cloudflare, so a hub that outlived its memory rebuilds from them.
 * It keeps no timers and no storage, which would stop a Durable Object from hibernating:
 * connection lifetime and silence are checked when it publishes or a roster changes. A socket
 * near the end of its lifetime is asked to renew on the next of those, so its tab can open a new
 * one before this one closes and miss nothing.
 */

import type { RoleLevel } from "@emdash-cms/auth";

import { capUserName, CONNECTION_LIFETIME_MS } from "../rooms/limits.js";
import type { RoomTokenClaims } from "../rooms/token.js";
import { CLOSE_CODES } from "../rooms/types.js";
import { HUB_NAME } from "../rooms/types.js";
import type { Change, ChangeOp } from "./publish.js";
import { grantedChannels, maySubscribe, parseTopic, topicAndAncestors } from "./topics.js";

export const MAX_HUB_TOPICS = 32;
/** Plugin channels a socket keeps from its ticket. */
const MAX_HUB_CHANNELS = 64;
/** What a Durable Object keeps per socket is 16 KiB serialized; this leaves room for its framing. */
const MAX_STATE_BYTES = 15 * 1024;
export const MAX_HUB_MESSAGE_BYTES = 16 * 1024;
/**
 * Tabs ping every 30 s, but browsers run a hidden tab's timers only about once a minute, so a
 * socket silent this long is gone.
 */
export const SILENT_HUB_SOCKET_MS = 3 * 60 * 1000;
/** How long before the end of its lifetime a socket is asked to renew. */
export const RENEW_HUB_SOCKET_MS = 60 * 1000;
const MAX_IDS = 50;
const GOING_AWAY = 1001;
const MESSAGE_TOO_BIG = 1009;
const OPS: ReadonlySet<string> = new Set<ChangeOp>(["create", "update", "delete"]);
const ACTIVITIES: ReadonlySet<string> = new Set<Activity>(["viewing", "editing"]);
const WIDE_CHARACTER = /[\u0100-\uffff]/;

export type Activity = "viewing" | "editing";

/** Where a tab says it is. */
export interface Place {
	topic: string;
	activity: Activity;
}

/** What a socket keeps through hibernation. Plain data, so it fits an attachment. */
export interface HubSocketState {
	/** Hub code reads attachments that older code wrote, so the shape is versioned. */
	v: 2;
	userId: string;
	role: RoleLevel;
	connectedAt: number;
	topics: string[];
	/** Empty for a ticket an older Worker signed, whose socket can't announce a place. */
	name: string;
	/** The tab, from the ticket. Null where the ticket has none, which can't announce either. */
	clientId: string | null;
	here: Place | null;
	/**
	 * The plugin channels, by `pluginChannelKey`, whose permission the role has. Absent from
	 * attachments older code wrote, which read as none.
	 */
	channels: string[];
}

/** A tab in a roster. */
export interface PresenceEntry {
	userId: string;
	name: string;
	clientId: string;
	activity: Activity;
}

/** Everyone at one topic. An empty list means no one is there anymore. */
export interface PresencePlace {
	topic: string;
	people: PresenceEntry[];
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

export type ClientFrame =
	/** `v`, which grows with each frame, is echoed in the replies to it. Tabs from before it omit it. */
	| { t: "topics"; topics: string[]; v?: number }
	/** A null topic says the tab is nowhere the hub shows. */
	| { t: "here"; topic: string | null; activity?: Activity };
export type HubFrame =
	| { t: "changes"; changes: Change[] }
	/**
	 * The rosters of the topics at or under the socket's subscriptions that it may see. With
	 * `all`, the list is every place that has anyone, and a place it leaves out is empty.
	 */
	| { t: "presence"; places: PresencePlace[]; all?: true; v?: number }
	/**
	 * Open a new socket, then close this one. Sent once per socket while the hub stays awake,
	 * near the end of its lifetime. Tabs from before it ignore it.
	 */
	| { t: "renew" }
	/**
	 * Another socket of the same tab now gets the changes to the topics it sent as version `v`, so
	 * this one can close. Every change sent before it reached this socket first. Tabs from before it
	 * ignore it.
	 */
	| { t: "handoff"; v?: number };

export interface HubOptions {
	sockets: HubSockets;
	now?: () => number;
}

export class Hub {
	readonly #sockets: HubSockets;
	readonly #now: () => number;
	/** Used tickets' nonces, until they expire. Lost with the hub's memory. */
	readonly #used = new Map<string, number>();
	/** Places whose rosters changed and haven't been sent. Empty between calls. */
	readonly #dirty = new Set<string>();
	/** Sockets asked to renew. Lost with the hub's memory, after which they are asked again. */
	readonly #renewing = new WeakSet<HubSocket>();

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
		const channels = grantedChannels(role, ticket.channels ?? {}).slice(0, MAX_HUB_CHANNELS);
		return {
			v: 2,
			userId: ticket.userId,
			role,
			connectedAt: now,
			topics: [],
			name: capUserName(ticket.name ?? ""),
			clientId: ticket.clientId && ticket.clientId.length <= 64 ? ticket.clientId : null,
			here: null,
			channels,
		};
	}

	/**
	 * A text frame from a tab: the topics it shows, which become the ones it may subscribe to and
	 * get it every roster under them, or the place it is at.
	 */
	receive(socket: HubSocket, message: string): void {
		const now = this.#now();
		if (new TextEncoder().encode(message).byteLength > MAX_HUB_MESSAGE_BYTES) {
			this.#close(socket, MESSAGE_TOO_BIG, "The message is too big");
		} else if (this.#live(socket, now)) {
			const frame = readClientFrame(message);
			if (frame?.t === "topics") this.#subscribe(socket, frame.topics, now, frame.v);
			else if (frame?.t === "here") this.#announce(socket, frame);
		}
		this.#sendRosters(now);
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
				this.#close(socket, CLOSE_CODES.rejoin, "The user's access changed");
				closed.add(socket);
			}
		}
		const now = this.#now();
		const reaches = changes.map((change) => topicAndAncestors(change.topic));
		for (const socket of this.#sockets.all()) {
			if (closed.has(socket) || this.#silent(socket, now)) continue;
			const { topics } = socket.state;
			const matching = changes.filter((_, index) =>
				reaches[index].some((topic) => topics.includes(topic)),
			);
			if (matching.length > 0) {
				const frame: HubFrame = { t: "changes", changes: matching };
				socket.send(JSON.stringify(frame));
			}
			// After the frame, so the socket that reached its lifetime doesn't miss the change.
			this.#expired(socket, now);
		}
		this.#sendRosters(now);
	}

	/** A socket closed from the other side, which the host has already left out of its sockets. */
	left(state: HubSocketState): void {
		if (!state.here) return;
		this.#dirty.add(state.here.topic);
		this.#sendRosters(this.#now());
	}

	#subscribe(socket: HubSocket, requested: string[], now: number, version?: number): void {
		const topics = [...new Set(requested)]
			.filter((topic) => maySubscribe(socket.state.role, topic, socket.state.channels))
			.slice(0, MAX_HUB_TOPICS);
		while (topics.length > 0 && !fits({ ...socket.state, topics })) topics.pop();
		socket.save({ ...socket.state, topics });
		const places: PresencePlace[] = [];
		for (const [topic, people] of this.#rosters(now, (place) => sees(socket.state, place))) {
			places.push({ topic, people });
		}
		const echo = version === undefined ? {} : { v: version };
		const frame: HubFrame = { t: "presence", places, all: true, ...echo };
		socket.send(JSON.stringify(frame));
		const { clientId, userId } = socket.state;
		if (!clientId) return;
		const handoff: HubFrame = { t: "handoff", ...echo };
		for (const other of this.#sockets.all()) {
			if (other !== socket && other.state.clientId === clientId && other.state.userId === userId) {
				other.send(JSON.stringify(handoff));
			}
		}
	}

	#announce(socket: HubSocket, frame: { topic: string | null; activity: Activity }): void {
		const { state } = socket;
		if (!state.name || !state.clientId) return;
		if (frame.topic !== null && !maySubscribe(state.role, frame.topic, state.channels)) return;
		const here = frame.topic === null ? null : { topic: frame.topic, activity: frame.activity };
		if (here?.topic === state.here?.topic && here?.activity === state.here?.activity) return;
		const next = { ...state, here };
		if (!fits(next)) return;
		socket.save(next);
		if (state.here) this.#dirty.add(state.here.topic);
		if (here) this.#dirty.add(here.topic);
	}

	/** Sends each changed roster to the sockets that may see it, in one frame each. */
	#sendRosters(now: number): void {
		while (this.#dirty.size > 0) {
			const changed = new Set(this.#dirty);
			this.#dirty.clear();
			// Closing a stale socket here marks its place for the next round.
			const rosters = this.#rosters(now, (topic) => changed.has(topic));
			const places = Array.from(changed, (topic) => ({ topic, people: rosters.get(topic) ?? [] }));
			for (const socket of this.#sockets.all()) {
				const visible = places.filter((place) => sees(socket.state, place.topic));
				if (visible.length === 0) continue;
				const frame: HubFrame = { t: "presence", places: visible };
				socket.send(JSON.stringify(frame));
			}
		}
	}

	/** Who is at each place `includes` picks. Closes the stale sockets it finds there. */
	#rosters(now: number, includes: (topic: string) => boolean): Map<string, PresenceEntry[]> {
		const rosters = new Map<string, PresenceEntry[]>();
		for (const socket of this.#sockets.all()) {
			const { here, userId, name, clientId } = socket.state;
			if (!here || !clientId || !includes(here.topic) || !this.#live(socket, now)) continue;
			let people = rosters.get(here.topic);
			if (!people) rosters.set(here.topic, (people = []));
			people.push({ userId, name, clientId, activity: here.activity });
		}
		return rosters;
	}

	/** Closes a socket gone silent or past its lifetime, and asks one near its end to renew. */
	#live(socket: HubSocket, now: number): boolean {
		return !this.#silent(socket, now) && !this.#expired(socket, now);
	}

	#silent(socket: HubSocket, now: number): boolean {
		if (now - socket.seenAt() <= SILENT_HUB_SOCKET_MS) return false;
		this.#close(socket, GOING_AWAY, "The connection went silent");
		return true;
	}

	#expired(socket: HubSocket, now: number): boolean {
		const age = now - socket.state.connectedAt;
		if (age >= CONNECTION_LIFETIME_MS) {
			this.#close(socket, CLOSE_CODES.rejoin, "The connection reached its lifetime");
			return true;
		}
		if (age >= CONNECTION_LIFETIME_MS - RENEW_HUB_SOCKET_MS && !this.#renewing.has(socket)) {
			this.#renewing.add(socket);
			const frame: HubFrame = { t: "renew" };
			socket.send(JSON.stringify(frame));
		}
		return false;
	}

	#close(socket: HubSocket, code: number, reason: string): void {
		socket.close(code, reason);
		if (socket.state.here) this.#dirty.add(socket.state.here.topic);
	}
}

/** Whether a socket may see the roster of `topic`: it shows the topic or one above it, and may. */
function sees(state: HubSocketState, topic: string): boolean {
	return (
		topicAndAncestors(topic).some((reach) => state.topics.includes(reach)) &&
		maySubscribe(state.role, topic, state.channels)
	);
}

/** Whether a state stays under what a Durable Object keeps per socket. */
function fits(state: HubSocketState): boolean {
	const json = JSON.stringify(state);
	// V8 stores a string with any character past Latin-1 at two bytes per code unit.
	return json.length * (WIDE_CHARACTER.test(json) ? 2 : 1) <= MAX_STATE_BYTES;
}

/**
 * The socket state an attachment holds, or null when this code can't read it. A state from before
 * presence reads as one that can't announce.
 */
export function readHubSocketState(value: unknown): HubSocketState | null {
	if (typeof value !== "object" || value === null) return null;
	const state = value as Partial<Omit<HubSocketState, "v">> & { v?: unknown };
	if (
		(state.v !== 1 && state.v !== 2) ||
		typeof state.userId !== "string" ||
		typeof state.role !== "number" ||
		typeof state.connectedAt !== "number" ||
		!Array.isArray(state.topics)
	) {
		return null;
	}
	const { userId, role, connectedAt, topics } = state;
	if (state.v === 1) {
		return {
			v: 2,
			userId,
			role,
			connectedAt,
			topics,
			name: "",
			clientId: null,
			here: null,
			channels: [],
		};
	}
	if (typeof state.name !== "string") return null;
	const clientId = typeof state.clientId === "string" ? state.clientId : null;
	const here = isPlace(state.here) ? state.here : null;
	const channels = Array.isArray(state.channels)
		? state.channels.filter((channel): channel is string => typeof channel === "string")
		: [];
	return { v: 2, userId, role, connectedAt, topics, name: state.name, clientId, here, channels };
}

function isPlace(value: unknown): value is Place {
	return (
		typeof value === "object" &&
		value !== null &&
		"topic" in value &&
		typeof value.topic === "string" &&
		"activity" in value &&
		typeof value.activity === "string" &&
		ACTIVITIES.has(value.activity)
	);
}

/** The frame a tab sent, or null when it isn't one this hub reads. */
function readClientFrame(
	message: string,
):
	| { t: "topics"; topics: string[]; v?: number }
	| { t: "here"; topic: string | null; activity: Activity }
	| null {
	let frame: unknown;
	try {
		frame = JSON.parse(message);
	} catch {
		return null;
	}
	if (typeof frame !== "object" || frame === null || !("t" in frame)) return null;
	if (frame.t === "topics" && "topics" in frame && Array.isArray(frame.topics)) {
		const topics = frame.topics.filter((topic): topic is string => typeof topic === "string");
		const v = "v" in frame ? frame.v : undefined;
		return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
			? { t: "topics", topics, v }
			: { t: "topics", topics };
	}
	if (frame.t === "here" && "topic" in frame) {
		const { topic } = frame;
		if (topic !== null && typeof topic !== "string") return null;
		const activity = "activity" in frame ? frame.activity : undefined;
		if (activity !== undefined && (typeof activity !== "string" || !ACTIVITIES.has(activity))) {
			return null;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked against ACTIVITIES
		return { t: "here", topic, activity: (activity as Activity | undefined) ?? "viewing" };
	}
	return null;
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
