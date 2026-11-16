/**
 * Room and realtime hub upgrades from the site's own HTTP server. Astro has no WebSocket API, so
 * the server is found through the response it sends for an EmDash request, and sockets are
 * completed with `ws`.
 */

import dc from "node:diagnostics_channel";
import { IncomingMessage, type Server } from "node:http";
import { Server as NetServer } from "node:net";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { HUB_NAME, isRealtimePath } from "../../realtime/path.js";
import { MAX_UPDATE_BYTES } from "../limits.js";
import type { RoomTokenClaims } from "../token.js";
import { CLOSE_CODES, roomIdFromPath, type RoomConnection } from "../types.js";
import type { AcceptedConnection, AcceptedHubConnection, HubConnection } from "./registry.js";

const LOG = "[co-editing]";
const PING_INTERVAL_MS = 30_000;
const NOT_FOUND = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/** The registry that takes room and hub sockets. */
export interface UpgradeRegistry {
	/** The claims of a token signed for the room, or for the hub with its name, or null. */
	verify(roomId: string, token: string): Promise<RoomTokenClaims | null>;
	accept(
		roomId: string,
		nonce: string,
		connection: RoomConnection,
		userId?: string,
	): AcceptedConnection | null;
	acceptHub(ticket: RoomTokenClaims, connection: HubConnection): AcceptedHubConnection | null;
}

/** Node.js 22.21 and 24.9 onward decide upgrades through this own property of each server. */
type UpgradeServer = Server & {
	shouldUpgradeCallback?: (this: Server, request: IncomingMessage) => boolean;
};

interface UpgradeState {
	subscribed: boolean;
	servers: WeakSet<object>;
	/** Whether any server has had the listener attached. */
	attached: boolean;
	registry: UpgradeRegistry | null;
}

// A development restart runs this module again; it must add no second subscription or listener.
const STATE_KEY = Symbol.for("emdash:rooms:upgrades");
const store = globalThis as Record<symbol, unknown>;

function state(): UpgradeState {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let current = store[STATE_KEY] as UpgradeState | undefined;
	if (!current) {
		current = { subscribed: false, servers: new WeakSet(), attached: false, registry: null };
		store[STATE_KEY] = current;
	}
	return current;
}

// `ws` closes larger frames with 1009; up to this size the room closes them itself, with `reset`.
const sockets = new WebSocketServer({
	noServer: true,
	clientTracking: false,
	maxPayload: 2 * MAX_UPDATE_BYTES,
});

/** Watches for the site's servers, once per process. */
export function watchServers(): void {
	const current = state();
	if (current.subscribed) return;
	current.subscribed = true;
	dc.subscribe("http.server.response.finish", onResponseFinish);
}

/** Whether upgrades can reach rooms: a server has had the listener attached. */
export function serverAttached(): boolean {
	return state().attached;
}

export function setUpgradeRegistry(registry: UpgradeRegistry): void {
	state().registry = registry;
}

/** Clears the slot only while it holds this registry, so an older one never clears a newer one. */
export function clearUpgradeRegistry(registry: UpgradeRegistry): void {
	const current = state();
	if (current.registry === registry) current.registry = null;
}

function onResponseFinish(message: unknown): void {
	if (!isResponseFinish(message)) return;
	const current = state();
	const { server, request } = message;
	if (current.servers.has(server) || !request.url?.includes("/_emdash/")) return;
	current.servers.add(server);
	current.attached = true;
	attach(server);
}

function isResponseFinish(
	message: unknown,
): message is { server: UpgradeServer; request: IncomingMessage } {
	return (
		typeof message === "object" &&
		message !== null &&
		"server" in message &&
		message.server instanceof NetServer &&
		"request" in message &&
		message.request instanceof IncomingMessage
	);
}

function attach(server: UpgradeServer): void {
	const previous = server.shouldUpgradeCallback;
	const narrowed = typeof previous === "function";
	if (narrowed) {
		// Counted at call time, so a listener added later, such as Vite's, still counts.
		server.shouldUpgradeCallback = function (request) {
			return (
				upgradeTarget(request) !== null ||
				(this.listenerCount("upgrade") > 1 && previous.call(this, request))
			);
		};
	}
	server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		const room = upgradeTarget(request);
		if (room) {
			// The server stops handling the socket's errors once it emits the upgrade.
			const onError = () => socket.destroy();
			socket.on("error", onError);
			void (async () => {
				const claims = await verify(room, tokenOf(request.url ?? ""));
				socket.off("error", onError);
				sockets.handleUpgrade(request, socket, head, (ws) => connect(ws, room, claims));
			})();
			return;
		}
		// Without the callback, a server with an upgrade listener passes it every upgrade request.
		if (!narrowed && server.listenerCount("upgrade") === 1) refuse(socket);
	});
}

/**
 * The room a WebSocket upgrade on a room path is for, or the hub's name for the realtime path,
 * under any base path.
 */
function upgradeTarget(request: IncomingMessage): string | null {
	if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
		return null;
	}
	const url = request.url ?? "";
	const query = url.indexOf("?");
	const pathname = query === -1 ? url : url.slice(0, query);
	return isRealtimePath(pathname) ? HUB_NAME : roomIdFromPath(pathname);
}

function tokenOf(url: string): string {
	const query = url.indexOf("?");
	if (query === -1) return "";
	return new URLSearchParams(url.slice(query + 1)).get("token") ?? "";
}

function refuse(socket: Duplex): void {
	socket.on("error", () => socket.destroy());
	socket.once("finish", () => socket.destroy());
	socket.end(NOT_FOUND);
}

async function verify(room: string, token: string): Promise<RoomTokenClaims | null> {
	try {
		return (await state().registry?.verify(room, token)) ?? null;
	} catch (error) {
		console.error(`${LOG} couldn't check a room token:`, error);
		return null;
	}
}

function connect(ws: WebSocket, room: string, claims: RoomTokenClaims | null): void {
	// `ws` closes the socket after a protocol error; the close event below cleans up.
	ws.on("error", () => {});
	const connection: RoomConnection = {
		send: (bytes) => {
			if (ws.readyState === ws.OPEN) ws.send(bytes);
		},
		close: (code, reason) => ws.close(code, reason),
	};
	const registry = state().registry;
	if (!registry) {
		connection.close(CLOSE_CODES.busy, "No rooms run here");
		return;
	}
	if (!claims) {
		connection.close(CLOSE_CODES.busy, "No valid token");
		return;
	}
	if (room === HUB_NAME) {
		connectHub(ws, registry, claims);
		return;
	}
	let accepted: AcceptedConnection | null;
	try {
		accepted = registry.accept(room, claims.nonce, connection, claims.userId);
	} catch (error) {
		console.error(`${LOG} room ${room} couldn't take a socket:`, error);
		connection.close(CLOSE_CODES.busy, "The room couldn't take the socket");
		return;
	}
	if (!accepted) return;
	const stopPinging = keepAlive(ws);
	ws.on("message", (data, isBinary) => {
		if (isBinary) accepted.receive(bytesOf(data));
	});
	ws.on("close", () => {
		stopPinging();
		accepted.disconnect();
	});
}

function connectHub(ws: WebSocket, registry: UpgradeRegistry, ticket: RoomTokenClaims): void {
	let accepted: AcceptedHubConnection | null;
	try {
		accepted = registry.acceptHub(ticket, {
			send: (frame) => {
				if (ws.readyState === ws.OPEN) ws.send(frame);
			},
			close: (code, reason) => ws.close(code, reason),
		});
	} catch (error) {
		console.error("[realtime] the hub couldn't take a socket:", error);
		ws.close(CLOSE_CODES.busy, "The hub couldn't take the socket");
		return;
	}
	if (!accepted) return;
	const stopPinging = keepAlive(ws);
	ws.on("message", (data, isBinary) => {
		if (isBinary) return;
		const text = Buffer.from(bytesOf(data)).toString("utf8");
		// Cloudflare answers the tab's ping without waking the hub; this matches it.
		if (text === "ping") ws.send("pong");
		else accepted.receive(text);
	});
	ws.on("close", () => {
		stopPinging();
		accepted.disconnect();
	});
}

/**
 * A peer that vanished without closing would keep its room open. Browsers answer pings on their
 * own, so a socket that didn't answer the last one is gone.
 */
function keepAlive(ws: WebSocket): () => void {
	let answered = true;
	ws.on("pong", () => {
		answered = true;
	});
	const timer = setInterval(() => {
		if (!answered) {
			ws.terminate();
			return;
		}
		answered = false;
		ws.ping();
	}, PING_INTERVAL_MS);
	if (typeof timer === "object" && "unref" in timer) timer.unref();
	return () => clearInterval(timer);
}

function bytesOf(data: RawData): Uint8Array {
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
