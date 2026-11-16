import { CLOSE_CODES, roomIdFromPath, verifyRoomToken } from "emdash/internal/co-editing";

import { roomsBinding } from "./binding.js";

/**
 * Forwards a room's WebSocket upgrade to its Durable Object, or returns null for any other
 * request. A Worker with its own `fetch` calls this first.
 */
export function handleRoomUpgrade(request: Request, env: unknown): Promise<Response> | null {
	if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return null;
	}
	const url = new URL(request.url);
	const token = url.searchParams.get("token");
	if (token === null) return null;
	const roomId = roomIdFromPath(url.pathname);
	const rooms = roomsBinding(env);
	if (!roomId || !rooms) return null;
	return forward(request, rooms, roomId, token);
}

async function forward(
	request: Request,
	rooms: NonNullable<ReturnType<typeof roomsBinding>>,
	roomId: string,
	token: string,
): Promise<Response> {
	// Any name creates its Durable Object, so only a token signed for this room reaches one.
	let verified = false;
	try {
		verified = (await verifyRoomToken(token, roomId, tokenSecret)) !== null;
	} catch (error) {
		console.error("[co-editing] couldn't check a room token:", error);
	}
	if (!verified) return refuseSocket();
	return rooms.getByName(roomId).fetch(request);
}

async function tokenSecret(): Promise<string> {
	// Loaded on first use, as the room's site loads them.
	const [{ withEmDashRuntime }, { resolveRoomTokenSecret }] = await Promise.all([
		import("emdash/middleware"),
		import("emdash/internal/co-editing/site"),
	]);
	return withEmDashRuntime((runtime) => resolveRoomTokenSecret(runtime.db));
}

/** Closes the socket with `busy`, as a room does for a token it doesn't hold. */
function refuseSocket(): Response {
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.close(CLOSE_CODES.busy, "No valid token");
	return new Response(null, { status: 101, webSocket: client });
}
