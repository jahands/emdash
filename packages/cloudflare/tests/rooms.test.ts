import { CLOSE_CODES, RoomSaveError, signRoomToken } from "emdash/internal/co-editing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fakeEnv, rooms, astroFetch, secret } = vi.hoisted(() => {
	const stub = {
		fetch: vi.fn(async (_request: Request) => new Response("room")),
		save: vi.fn(async (_actorId: string, _rev?: string): Promise<unknown> => null),
	};
	return {
		fakeEnv: {} as Record<string, unknown>,
		rooms: { stub, getByName: vi.fn((_name: string) => stub) },
		astroFetch: vi.fn(async (_request: Request) => new Response("astro")),
		secret: vi.fn(async (_db: unknown) => "room-secret"),
	};
});

vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));
vi.mock("@astrojs/cloudflare/entrypoints/server", () => ({ default: { fetch: astroFetch } }));
vi.mock("astro/app/entrypoint", () => ({ createApp: () => ({ manifest: {} }) }));
vi.mock("emdash/middleware", () => ({
	withEmDashRuntime: (run: (runtime: { db: unknown }) => unknown) => run({ db: {} }),
}));
vi.mock("emdash/internal/co-editing/site", () => ({ resolveRoomTokenSecret: secret }));
vi.mock("../src/sandbox/bridge.js", () => ({ PluginBridge: vi.fn() }));
vi.mock("../src/rooms/object.js", () => ({ EmDashRoom: vi.fn() }));
vi.mock("../src/rooms/site.js", () => ({ EmDashRoomSite: vi.fn() }));

import { createRoomHost } from "../src/rooms/host.js";
import { handleRoomUpgrade } from "../src/rooms/upgrade.js";
import worker from "../src/worker.js";

const ROOM = "posts:01 ID";
const ROOM_PATH = "https://site.test/blog/_emdash/api/content/posts/01%20ID/room";

function sign(overrides: { roomId?: string; expiresAt?: number; key?: string } = {}) {
	return signRoomToken(overrides.key ?? "room-secret", {
		roomId: overrides.roomId ?? ROOM,
		userId: "ana",
		nonce: "nonce",
		expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
	});
}

function upgrade(token: string | null, path = ROOM_PATH, method = "GET"): Request {
	const url = token === null ? path : `${path}?token=${encodeURIComponent(token)}`;
	return new Request(url, { method, headers: { Upgrade: "websocket" } });
}

const ctx = {} as ExecutionContext;

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
});

describe("handleRoomUpgrade", () => {
	it("forwards an upgrade with a token signed for the room to the entry's Durable Object", async () => {
		const request = upgrade(await sign());
		const response = await handleRoomUpgrade(request, { EMDASH_ROOMS: rooms });
		expect(await response?.text()).toBe("room");
		expect(rooms.getByName).toHaveBeenCalledWith(ROOM);
		expect(rooms.stub.fetch).toHaveBeenCalledWith(request);
	});

	it.each([
		["a request that isn't an upgrade", () => new Request(`${ROOM_PATH}?token=x`)],
		["an upgrade that isn't a GET", () => upgrade("x", ROOM_PATH, "POST")],
		["an upgrade without a token", () => upgrade(null)],
		[
			"an upgrade on another path",
			() => upgrade("x", "https://site.test/_emdash/api/content/posts/1"),
		],
		[
			"an upgrade on a path that names no room",
			() => upgrade("x", "https://site.test/_emdash/api/content/%3Aposts/1/room"),
		],
		[
			"an upgrade on a path whose collection isn't a collection slug",
			() => upgrade("x", "https://site.test/_emdash/api/content/_realtime/content%2Fposts/room"),
		],
	])("ignores %s", (_name, request) => {
		expect(handleRoomUpgrade(request(), { EMDASH_ROOMS: rooms })).toBeNull();
		expect(rooms.getByName).not.toHaveBeenCalled();
	});

	it("ignores room upgrades when the Worker has no room binding", () => {
		expect(handleRoomUpgrade(upgrade("x"), {})).toBeNull();
		expect(handleRoomUpgrade(upgrade("x"), undefined)).toBeNull();
	});

	describe("with a token not signed for the room", () => {
		const server = { accept: vi.fn(), close: vi.fn() };
		const client = {};

		beforeEach(() => {
			vi.stubGlobal(
				"WebSocketPair",
				class {
					0 = client;
					1 = server;
				},
			);
			// Node.js refuses the 101 status a Worker completes an upgrade with.
			vi.stubGlobal(
				"Response",
				class {
					constructor(
						readonly body: null,
						readonly init: ResponseInit & { webSocket?: unknown },
					) {}
				},
			);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it.each([
			["empty", async () => ""],
			["unsigned", async () => "Aa0_-".repeat(8) + "Aa0"],
			["signed with another key", () => sign({ key: "other" })],
			["signed for another room", () => sign({ roomId: "posts:other" })],
			["expired", () => sign({ expiresAt: Date.now() - 1 })],
			["with its signature changed", async () => `${await sign()}A`],
		])("closes the socket with busy without reaching the namespace: %s", async (_name, token) => {
			const response = await handleRoomUpgrade(upgrade(await token()), { EMDASH_ROOMS: rooms });
			expect(response).toMatchObject({ init: { status: 101, webSocket: client } });
			expect(server.accept).toHaveBeenCalled();
			expect(server.close).toHaveBeenCalledWith(CLOSE_CODES.busy, "No valid token");
			expect(rooms.getByName).not.toHaveBeenCalled();
		});

		it("looks up the secret only for a token whose claims pass", async () => {
			await handleRoomUpgrade(upgrade(await sign({ expiresAt: Date.now() - 1 })), {
				EMDASH_ROOMS: rooms,
			});
			await handleRoomUpgrade(upgrade(await sign({ roomId: "posts:other" })), {
				EMDASH_ROOMS: rooms,
			});
			expect(secret).not.toHaveBeenCalled();
		});

		it("closes the socket with busy when the secret can't be read", async () => {
			secret.mockRejectedValueOnce(new Error("database down"));
			vi.spyOn(console, "error").mockImplementation(() => {});
			await handleRoomUpgrade(upgrade(await sign()), { EMDASH_ROOMS: rooms });
			expect(server.close).toHaveBeenCalledWith(CLOSE_CODES.busy, "No valid token");
			expect(rooms.getByName).not.toHaveBeenCalled();
		});
	});
});

describe("the Worker's fetch", () => {
	it("forwards room upgrades before Astro runs, and leaves other requests to Astro", async () => {
		const env = { EMDASH_ROOMS: rooms };
		const fetch = worker.fetch as (
			r: Request,
			e: unknown,
			c: ExecutionContext,
		) => Promise<Response>;
		expect(await (await fetch(upgrade(await sign()), env, ctx)).text()).toBe("room");
		expect(astroFetch).not.toHaveBeenCalled();
		expect(await (await fetch(new Request(ROOM_PATH), env, ctx)).text()).toBe("astro");
		expect(rooms.stub.fetch).toHaveBeenCalledTimes(1);
	});
});

describe("createRoomHost", () => {
	it("returns null without the room binding", () => {
		expect(createRoomHost()).toBeNull();
	});

	it("throws a room's failed operation save as RoomSaveError", async () => {
		fakeEnv.EMDASH_ROOMS = rooms;
		const host = createRoomHost();
		rooms.stub.save.mockResolvedValueOnce({
			failed: { reason: "REFUSED", code: "VALIDATION_ERROR", message: "Title is required" },
		});
		const failure = await host?.save("posts:1", "ana").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RoomSaveError);
		expect(failure).toMatchObject({ reason: "REFUSED", code: "VALIDATION_ERROR" });
		expect(rooms.getByName).toHaveBeenCalledWith("posts:1");

		rooms.stub.save.mockResolvedValueOnce({ rev: "rev-2", hold: "h" });
		expect(await host?.save("posts:1", "ana", "rev-1")).toEqual({ rev: "rev-2", hold: "h" });
		expect(rooms.stub.save).toHaveBeenLastCalledWith("ana", "rev-1");
	});
});
