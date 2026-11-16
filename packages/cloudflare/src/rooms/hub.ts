/**
 * The realtime hub's half of `EmDashRoom`, for the object named `HUB_NAME`. Each socket's state
 * lives in its attachment and its user in a tag, so a hub that hibernated rebuilds from its
 * sockets on the first event that needs them. Pings get their pong from the runtime without
 * waking the object.
 */

import { CLOSE_CODES, readRoomToken } from "emdash/internal/co-editing";
import type { Hub, HubSocket, HubSocketState } from "emdash/internal/realtime/hub";
// @ts-ignore - virtual module
import { loadHubEngine } from "virtual:emdash/room-engine";

type HubEngine = Awaited<ReturnType<NonNullable<typeof loadHubEngine>>>;

/** Longest tag Cloudflare keeps. */
const MAX_TAG_LENGTH = 256;
const UNSUPPORTED_DATA = 1003;

const userTag = (userId: string) => `user:${userId}`;

export class HubObject {
	readonly #ctx: DurableObjectState;
	#loading: Promise<{ engine: HubEngine; hub: Hub } | null> | null = null;
	/** Built from the sockets' attachments when first needed after a wake. */
	#sockets: Map<WebSocket, HubSocket> | null = null;
	/** When each socket last sent a frame the hub handled, since this wake. */
	readonly #messagedAt = new WeakMap<WebSocket, number>();

	constructor(ctx: DurableObjectState) {
		this.#ctx = ctx;
		// Applies to every socket of the object, which is why rooms never set it.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async publish(changes: unknown): Promise<void> {
		(await this.#load())?.hub.publish(changes);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response(null, { status: 400 });
		}
		// The Worker verified the ticket before forwarding the upgrade.
		const ticket = readRoomToken(new URL(request.url).searchParams.get("token") ?? "");
		const loaded = await this.#load();
		const sockets = this.#all(loaded?.engine ?? null);
		const state = ticket && loaded ? loaded.hub.admit(ticket) : null;
		const { 0: client, 1: server } = new WebSocketPair();
		const tag = state ? userTag(state.userId) : "";
		if (!state || tag.length > MAX_TAG_LENGTH) {
			this.#ctx.acceptWebSocket(server);
			server.close(CLOSE_CODES.busy, "No valid ticket");
			return new Response(null, { status: 101, webSocket: client });
		}
		this.#ctx.acceptWebSocket(server, [tag, `role:${state.role}`]);
		server.serializeAttachment(state);
		sockets.set(server, this.#socket(server, state, sockets));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const loaded = await this.#load();
		const socket = this.#all(loaded?.engine ?? null).get(ws);
		if (!socket || !loaded) return;
		if (typeof message !== "string") {
			socket.close(UNSUPPORTED_DATA, "The hub takes text frames");
			return;
		}
		this.#messagedAt.set(ws, Date.now());
		loaded.hub.receive(socket, message);
	}

	webSocketClose(ws: WebSocket, code: number): void {
		this.#sockets?.delete(ws);
		try {
			// 1005 and 1006 report a close without a code, and can't be sent.
			ws.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// Already closed.
		}
	}

	webSocketError(ws: WebSocket): void {
		this.#sockets?.delete(ws);
	}

	/** The hub engine, imported and built on first use. Null with co-editing off. */
	#load(): Promise<{ engine: HubEngine; hub: Hub } | null> {
		this.#loading ??= (async () => {
			if (!loadHubEngine) return null;
			const engine = await loadHubEngine();
			const hub = new engine.Hub({
				sockets: {
					all: () => this.#all(engine).values(),
					ofUser: (userId) => {
						const sockets = this.#all(engine);
						return this.#ctx.getWebSockets(userTag(userId)).flatMap((ws) => sockets.get(ws) ?? []);
					},
				},
			});
			return { engine, hub };
		})();
		return this.#loading;
	}

	#all(engine: HubEngine | null): Map<WebSocket, HubSocket> {
		if (this.#sockets) return this.#sockets;
		const sockets = new Map<WebSocket, HubSocket>();
		this.#sockets = sockets;
		for (const ws of this.#ctx.getWebSockets()) {
			const attachment: unknown = ws.deserializeAttachment();
			// A closing socket's attachment is already cleared.
			if (attachment === null) continue;
			if (engine?.isHubSocketState(attachment)) {
				sockets.set(ws, this.#socket(ws, attachment, sockets));
			} else {
				// Written by hub code this version can't read; a new ticket gets a fresh state.
				closeSocket(ws, CLOSE_CODES.rejoin, "Join again");
			}
		}
		return sockets;
	}

	#socket(ws: WebSocket, state: HubSocketState, sockets: Map<WebSocket, HubSocket>): HubSocket {
		let current = state;
		const ctx = this.#ctx;
		const messagedAt = this.#messagedAt;
		return {
			get state() {
				return current;
			},
			send(frame) {
				try {
					ws.send(frame);
				} catch {
					// The socket closed; its close handler forgets it.
				}
			},
			close(code, reason) {
				sockets.delete(ws);
				closeSocket(ws, code, reason);
			},
			save(next) {
				ws.serializeAttachment(next);
				current = next;
			},
			seenAt() {
				const pinged = ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
				return Math.max(pinged, messagedAt.get(ws) ?? 0, current.connectedAt);
			},
		};
	}
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
	try {
		// So a socket still finishing its close isn't resumed as live after a wake.
		ws.serializeAttachment(null);
		ws.close(code, reason);
	} catch {
		// Already closed.
	}
}
