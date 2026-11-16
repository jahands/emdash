import { Role } from "@emdash-cms/auth";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HUB_NAME, signRoomToken } from "emdash/internal/co-editing";
import { describe, expect, it, vi } from "vitest";

import type { EmDashRoom } from "../../../cloudflare/src/rooms/object.js";
import { handleRoomUpgrade } from "../../../cloudflare/src/rooms/upgrade.js";
import { CLOSE_CODES } from "../../src/rooms/types.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		EMDASH_ROOMS: DurableObjectNamespace<EmDashRoom>;
	}
}

const hub = () => env.EMDASH_ROOMS.getByName(HUB_NAME);

/** A ticket as the ticket route signs it. The Worker checks the key; the hub reads the claims. */
function ticket(userId: string, overrides: { roomId?: string; role?: number } = {}) {
	return signRoomToken("test-secret", {
		roomId: overrides.roomId ?? HUB_NAME,
		userId,
		nonce: crypto.randomUUID(),
		expiresAt: Date.now() + 30_000,
		role: "role" in overrides ? overrides.role : Role.EDITOR,
	});
}

class HubClient {
	readonly frames: unknown[] = [];
	readonly texts: string[] = [];
	closed: { code: number } | null = null;

	private constructor(private readonly ws: WebSocket) {
		ws.accept();
		ws.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			this.texts.push(event.data);
			if (event.data !== "pong") this.frames.push(JSON.parse(event.data));
		});
		ws.addEventListener("close", (event) => {
			this.closed ??= { code: event.code };
		});
	}

	static async open(stub: DurableObjectStub<EmDashRoom>, token: string): Promise<HubClient> {
		const response = await stub.fetch(
			`https://site.test/_emdash/api/realtime?token=${encodeURIComponent(token)}`,
			{ headers: { Upgrade: "websocket" } },
		);
		if (response.status !== 101 || !response.webSocket) {
			throw new Error(`No upgrade: ${response.status}`);
		}
		return new HubClient(response.webSocket);
	}

	send(frame: unknown): void {
		this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
	}

	close(): void {
		this.ws.close(1000, "done");
	}
}

/** Each open socket's topics, as its attachment keeps them. */
function attachedTopics(stub: DurableObjectStub<EmDashRoom>) {
	return runInDurableObject(stub, (_instance, state) =>
		state
			.getWebSockets()
			.map((ws) => ws.deserializeAttachment() as { userId: string; topics: string[] } | null)
			.filter((attachment) => attachment !== null)
			.map(({ userId, topics }) => ({ userId, topics }))
			.toSorted((a, b) => a.userId.localeCompare(b.userId)),
	);
}

describe("EmDashRoom as the realtime hub", () => {
	it("rebuilds its subscriptions from socket attachments after it is evicted", async () => {
		const stub = hub();
		const ana = await HubClient.open(stub, await ticket("ana"));
		const ben = await HubClient.open(stub, await ticket("ben"));
		ana.send({ t: "topics", topics: ["content/posts"] });
		ben.send({ t: "topics", topics: ["menus", "comments"] });
		await vi.waitFor(async () =>
			expect(await attachedTopics(stub)).toEqual([
				{ userId: "ana", topics: ["content/posts"] },
				{ userId: "ben", topics: ["menus", "comments"] },
			]),
		);

		await evictDurableObject(stub);
		await stub.publish([
			{ topic: "content/posts/01A", op: "update", origin: "tab-1" },
			{ topic: "menus", ids: ["m1"] },
		]);

		await vi.waitFor(() =>
			expect(ana.frames).toEqual([
				{ t: "changes", changes: [{ topic: "content/posts/01A", op: "update", origin: "tab-1" }] },
			]),
		);
		await vi.waitFor(() =>
			expect(ben.frames).toEqual([{ t: "changes", changes: [{ topic: "menus", ids: ["m1"] }] }]),
		);
		ana.close();
		ben.close();
	});

	it("answers pings with the runtime's auto-response", async () => {
		const ana = await HubClient.open(hub(), await ticket("ana"));

		ana.send("ping");

		await vi.waitFor(() => expect(ana.texts).toContain("pong"));
		ana.close();
	});

	it("closes a user's sockets with rejoin when their access changes", async () => {
		const stub = hub();
		const ana = await HubClient.open(stub, await ticket("ana"));
		const ben = await HubClient.open(stub, await ticket("ben"));
		await vi.waitFor(async () => expect(await attachedTopics(stub)).toHaveLength(2));

		await evictDurableObject(stub);
		await stub.publish([{ topic: "users/ana", op: "update" }]);

		await vi.waitFor(() => expect(ana.closed?.code).toBe(CLOSE_CODES.rejoin));
		expect(ben.closed).toBeNull();
		ben.close();
	});

	it.each([
		["a used ticket", "used"],
		["a room's token", "room"],
		["a ticket without a role", "no-role"],
		["no ticket", "none"],
	] as const)("closes a socket with %s with busy", async (_name, kind) => {
		const stub = hub();
		let token = "";
		if (kind === "used") {
			token = await ticket("ana");
			(await HubClient.open(stub, token)).close();
		} else if (kind === "room") {
			token = await ticket("ana", { roomId: "posts:entry" });
		} else if (kind === "no-role") {
			token = await ticket("ana", { role: undefined });
		}

		const client = await HubClient.open(stub, token);

		await vi.waitFor(() => expect(client.closed?.code).toBe(CLOSE_CODES.busy));
	});

	it("isn't reached through a room path", () => {
		const request = new Request("https://site.test/_emdash/api/content/_realtime/x/room?token=x", {
			headers: { Upgrade: "websocket" },
		});

		expect(handleRoomUpgrade(request, env)).toBeNull();
	});
});
