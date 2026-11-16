import { beforeEach, describe, expect, it, vi } from "vitest";

const { stored } = vi.hoisted(() => ({
	stored: {
		held: true,
		record: null as null | { editors: string[]; mergeBase: { document: Record<string, unknown> } },
		drop: vi.fn(async () => {}),
	},
}));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			readonly ctx: unknown,
			readonly env: unknown,
		) {}
	},
	exports: {},
}));
vi.mock("virtual:emdash/room-engine", () => ({ loadRoomEngine: null }));
vi.mock("../src/rooms/store.js", () => ({
	DurableObjectRoomStore: class {
		holdsState() {
			return stored.held;
		}
		readRecord() {
			return stored.record;
		}
		async drop() {
			await stored.drop();
			stored.held = false;
			stored.record = null;
		}
	},
}));

import { EmDashRoom } from "../src/rooms/object.js";

const HOUR = 60 * 60 * 1000;

function room() {
	const setAlarm = vi.fn(async (_at: number) => {});
	const ctx = { id: { name: "post:01" }, storage: { setAlarm }, getWebSockets: () => [] };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fields EmDashRoom reads
	return { room: new EmDashRoom(ctx as never, {} as never), setAlarm };
}

describe("EmDashRoom with co-editing off", () => {
	beforeEach(() => {
		stored.held = true;
		stored.record = { editors: ["ana"], mergeBase: { document: { title: "h1" } } };
		stored.drop.mockClear();
	});

	it("sets its alarm again while it holds unsaved edits, so they save once co-editing is on", async () => {
		const { room: off, setAlarm } = room();
		const before = Date.now();
		await off.alarm();
		expect(stored.drop).not.toHaveBeenCalled();
		expect(setAlarm).toHaveBeenCalledOnce();
		expect(setAlarm.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(before + HOUR);
	});

	it("sets its alarm again while a field waits for its next save", async () => {
		stored.record = { editors: [], mergeBase: { document: { title: null } } };
		const { room: off, setAlarm } = room();
		await off.alarm();
		expect(stored.drop).not.toHaveBeenCalled();
		expect(setAlarm).toHaveBeenCalledOnce();
	});

	it("drops state the site already has and lets its alarm lapse", async () => {
		stored.record = { editors: [], mergeBase: { document: { title: "h1" } } };
		const { room: off, setAlarm } = room();
		await off.alarm();
		expect(stored.drop).toHaveBeenCalledOnce();
		expect(setAlarm).not.toHaveBeenCalled();
	});

	it("lets its alarm lapse once it holds no state", async () => {
		stored.held = false;
		stored.record = null;
		const { room: off, setAlarm } = room();
		await off.alarm();
		expect(setAlarm).not.toHaveBeenCalled();
	});
});
