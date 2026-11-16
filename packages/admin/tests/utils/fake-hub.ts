import { expect, vi } from "vitest";

export interface PresenceEntry {
	userId: string;
	name: string;
	clientId: string;
	activity: "viewing" | "editing";
}

/** A realtime hub socket the test plays the server's side of. Install it with `vi.stubGlobal`. */
export class FakeSocket extends EventTarget {
	static readonly OPEN = 1;
	static instances: FakeSocket[] = [];
	readyState = 0;
	readonly sent: string[] = [];

	constructor(readonly url: string) {
		super();
		FakeSocket.instances.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close(code = 1000) {
		this.drop(code);
	}

	open() {
		this.readyState = FakeSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}

	push(frame: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
	}

	/** Sends a change from another tab. */
	change(topic: string, change: { ids?: string[]; op?: string; origin?: string } = {}) {
		this.push({ t: "changes", changes: [{ topic, origin: "other-tab", ...change }] });
	}

	drop(code: number) {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.dispatchEvent(new CloseEvent("close", { code }));
	}

	/** Sends rosters, as the hub does when someone moves; with `all`, everyone under the tab's topics. */
	presence(places: Array<{ topic: string; people: PresenceEntry[] }>, all = false) {
		this.push(all ? { t: "presence", places, all } : { t: "presence", places });
	}

	/** The place the tab last said it is at, or undefined before it said any. */
	here(): { topic: string | null; activity?: string } | undefined {
		for (const data of this.sent.toReversed()) {
			const frame = JSON.parse(data) as { t: string; topic: string | null; activity?: string };
			if (frame.t === "here") return { topic: frame.topic, activity: frame.activity };
		}
		return undefined;
	}

	/** The topics the last frame subscribed to. */
	topics(): string[] {
		for (const data of this.sent.toReversed()) {
			const frame = JSON.parse(data) as { t: string; topics?: string[] };
			if (frame.t === "topics") return frame.topics ?? [];
		}
		return [];
	}
}

/** The ticket route's answer that turns live updates on. */
export function ticketResponse(): Response {
	return new Response(
		JSON.stringify({ data: { mode: "live", url: "/_emdash/api/realtime", ticket: "ticket-1" } }),
		{ headers: { "Content-Type": "application/json" } },
	);
}

/** Opens the tab's hub socket once it exists, and waits until it subscribes to `topics`. */
export async function openHub(topics: string[]): Promise<FakeSocket> {
	await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
	const socket = FakeSocket.instances[0]!;
	socket.open();
	await vi.waitFor(() => expect(socket.topics()).toEqual(expect.arrayContaining(topics)));
	return socket;
}

/** Long enough for a change to have refetched had it been going to: past the throttle's first window. */
export function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 300));
}
