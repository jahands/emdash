import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openLiveConnection, type LiveConnection } from "../../src/lib/realtime/connection";
import { FakeSocket } from "../utils/fake-hub";

/** A socket whose close the browser reports later, as it does once the closing handshake ends. */
class SlowClosingSocket extends FakeSocket {
	closeRequested = false;

	override close() {
		this.closeRequested = true;
	}
}

describe("openLiveConnection", () => {
	let connection: LiveConnection | undefined;
	const events = {
		changes: vi.fn(),
		resync: vi.fn(),
		presence: vi.fn(),
	};

	beforeEach(() => {
		FakeSocket.instances = [];
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({ data: { mode: "live", url: "/_emdash/api/realtime", ticket: "ticket" } }),
		);
		events.changes.mockReset();
		events.resync.mockReset();
		events.presence.mockReset();
	});

	afterEach(() => {
		connection?.close();
		connection = undefined;
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function connected(topics: string[]): Promise<FakeSocket> {
		connection = openLiveConnection(events);
		connection.setTopics(topics);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		socket.ack();
		return socket;
	}

	it("moves to the new socket only on a handoff for the topics it sent there last", async () => {
		const old = await connected(["menus"]);
		vi.spyOn(Math, "random").mockReturnValue(0);
		old.push({ t: "renew" });
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
		const next = FakeSocket.instances[1]!;
		next.open();
		next.ack();
		const first = next.topicsVersion();

		connection!.setTopics(["menus", "widgets"]);
		old.push({ t: "handoff", v: first });
		expect(old.readyState).toBe(FakeSocket.OPEN);
		old.change("widgets");
		expect(events.changes).toHaveBeenCalledOnce();

		old.push({ t: "handoff", v: next.topicsVersion() });
		expect(old.readyState).toBe(3);
		expect(events.resync).not.toHaveBeenCalled();
	});

	it("doesn't take a handoff without a version, and moves over after the wait with a refetch", async () => {
		const old = await connected(["menus"]);
		vi.spyOn(Math, "random").mockReturnValue(0);
		old.push({ t: "renew" });
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
		const next = FakeSocket.instances[1]!;
		next.open();
		next.ack();

		old.push({ t: "handoff" });
		expect(old.readyState).toBe(FakeSocket.OPEN);
		await vi.waitFor(() => expect(old.readyState).toBe(3), { timeout: 7000 });
		expect(events.resync).toHaveBeenCalledOnce();
	});
});
