/**
 * The tab's one socket to the site's realtime hub. It gets a ticket from the server, tells the
 * hub which topics the tab shows and where the tab is, and reports the changes and rosters the
 * hub sends. It stays open for five minutes in a hidden tab, because a hibernated socket costs
 * nothing and every reconnect makes the tab refetch, and reconnects with jitter so a deploy
 * doesn't bring every tab back at once.
 */

import { API_BASE, apiFetch } from "../api/client.js";

export interface LiveChange {
	topic: string;
	ids?: string[];
	op?: string;
	/** The tab whose request made the change. */
	origin?: string;
}

export type PresenceActivity = "viewing" | "editing";

/** A tab at a place, as the hub stamps it from the tab's ticket. */
export interface LivePresenceEntry {
	userId: string;
	name: string;
	clientId: string;
	activity: PresenceActivity;
}

export interface LivePresencePlace {
	topic: string;
	/** Empty when no one is there anymore. */
	people: LivePresenceEntry[];
}

export interface LivePlace {
	topic: string;
	activity: PresenceActivity;
}

export interface LiveConnectionEvents {
	changes(changes: LiveChange[]): void;
	/** The socket opened again after a gap since `since`, in ms, in which changes may have been missed. */
	resync(since: number): void;
	/**
	 * Rosters under the tab's topics. With `all`, every place that has anyone, so a place left
	 * out is empty; the tab also gets an empty `all` when its socket closes.
	 */
	presence(places: LivePresencePlace[], all: boolean): void;
}

export interface LiveConnection {
	/** The topics the tab shows. Replaces the previous set. */
	setTopics(topics: readonly string[]): void;
	/** Where the tab is, or null for nowhere others are shown. Kept across reconnects. */
	setPlace(place: LivePlace | null): void;
	close(): void;
}

/** The co-editing room's close codes, which the hub uses too. */
const REJOIN = 4400;
const BUSY = 4403;
/** The hub answers without waking, and a Node.js server answers too. */
const PING_MS = 30_000;
const HIDDEN_GRACE_MS = 5 * 60_000;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const BUSY_RETRY_MS = 5000;
/**
 * Sockets that close before opening, or that the hub refuses, this many times in a row mean
 * something between the tab and the hub drops them, such as a proxy. The tab stops trying until
 * the admin reloads, and keeps the freshness it has without live updates.
 */
const MAX_FAILED_SOCKETS = 3;

type Target = { url: string; ticket: string };

export function openLiveConnection(events: LiveConnectionEvents): LiveConnection {
	let topics: readonly string[] = [];
	let place: LivePlace | null = null;
	let socket: WebSocket | null = null;
	let connecting = false;
	let stopped = false;
	/** Closed while the tab was hidden; it reopens when the tab shows again. */
	let paused = false;
	let everOpened = false;
	/** When the last open socket closed. */
	let closedAt = 0;
	let failures = 0;
	let attempt = 0;
	let retryTimer: number | undefined;
	let pingTimer: number | undefined;
	let hiddenTimer: number | undefined;

	function sendTopics(): void {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ t: "topics", topics }));
		}
	}

	function sendPlace(): void {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(
				JSON.stringify({ t: "here", topic: place?.topic ?? null, activity: place?.activity }),
			);
		}
	}

	async function connect(): Promise<void> {
		retryTimer = undefined;
		if (stopped || paused || socket || connecting) return;
		connecting = true;
		let target: Target | "off" | null;
		try {
			target = await fetchTicket();
		} finally {
			connecting = false;
		}
		if (stopped || paused || socket) return;
		if (target === "off") stop();
		else if (target) open(target);
		else retryIn(backoff());
	}

	function open(target: Target): void {
		const ws = new WebSocket(socketUrl(target));
		socket = ws;
		let opened = false;
		ws.addEventListener("open", () => {
			opened = true;
			attempt = 0;
			sendTopics();
			if (place) sendPlace();
			pingTimer = window.setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send("ping");
			}, PING_MS);
			if (everOpened) events.resync(closedAt);
			everOpened = true;
		});
		ws.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data === "pong") return;
			failures = 0;
			const frame = readFrame(event.data);
			if (frame?.t === "changes" && frame.changes.length > 0) events.changes(frame.changes);
			else if (frame?.t === "presence") events.presence(frame.places, frame.all);
		});
		ws.addEventListener("close", (event) => {
			if (socket === ws) socket = null;
			window.clearInterval(pingTimer);
			if (opened) {
				closedAt = Date.now();
				// Rosters stop reaching a closed socket, so what the tab knows would go stale.
				events.presence([], true);
			}
			if (stopped || paused) return;
			if (!opened || event.code === BUSY) failures++;
			else failures = 0;
			if (failures >= MAX_FAILED_SOCKETS) stop();
			else if (event.code === REJOIN) retryIn(Math.random() * 1000);
			else if (event.code === BUSY) retryIn(BUSY_RETRY_MS * (0.5 + Math.random()));
			else retryIn(backoff());
		});
	}

	function backoff(): number {
		const base = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? BUSY_RETRY_MS;
		attempt++;
		return base * (0.5 + Math.random());
	}

	function retryIn(ms: number): void {
		window.clearTimeout(retryTimer);
		retryTimer = window.setTimeout(() => void connect(), ms);
	}

	function onVisibility(): void {
		if (document.visibilityState === "hidden") {
			hiddenTimer ??= window.setTimeout(() => {
				hiddenTimer = undefined;
				paused = true;
				window.clearTimeout(retryTimer);
				const ws = socket;
				socket = null;
				ws?.close(1000, "The tab is hidden");
			}, HIDDEN_GRACE_MS);
			return;
		}
		window.clearTimeout(hiddenTimer);
		hiddenTimer = undefined;
		if (paused) {
			paused = false;
			void connect();
		}
	}

	function onOnline(): void {
		if (socket || stopped || paused) return;
		window.clearTimeout(retryTimer);
		void connect();
	}

	function stop(): void {
		stopped = true;
		window.clearTimeout(retryTimer);
		window.clearTimeout(hiddenTimer);
		window.clearInterval(pingTimer);
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("online", onOnline);
		const ws = socket;
		socket = null;
		ws?.close(1000, "Live updates stopped");
	}

	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("online", onOnline);
	void connect();

	return {
		setTopics(next) {
			topics = next;
			sendTopics();
		},
		setPlace(next) {
			if (next?.topic === place?.topic && next?.activity === place?.activity) return;
			place = next;
			sendPlace();
		},
		close: stop,
	};
}

/** A ticket, "off" where the host runs no hub or the user is signed out, or null to retry. */
async function fetchTicket(): Promise<Target | "off" | null> {
	try {
		const response = await apiFetch(`${API_BASE}/realtime`, { method: "POST" });
		if (response.status === 401 || response.status === 403) return "off";
		if (!response.ok) return null;
		const body: unknown = await response.json();
		const data = isRecord(body) && isRecord(body.data) ? body.data : null;
		if (data?.mode === "live" && typeof data.url === "string" && typeof data.ticket === "string") {
			return { url: data.url, ticket: data.ticket };
		}
		return "off";
	} catch {
		return null;
	}
}

function socketUrl({ url, ticket }: Target): string {
	const address = new URL(url, location.href);
	address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
	address.searchParams.set("token", ticket);
	return address.href;
}

type Frame =
	| { t: "changes"; changes: LiveChange[] }
	| { t: "presence"; places: LivePresencePlace[]; all: boolean };

function readFrame(text: string): Frame | null {
	let frame: unknown;
	try {
		frame = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(frame)) return null;
	if (frame.t === "changes" && Array.isArray(frame.changes)) {
		const changes = frame.changes.filter(
			(change): change is LiveChange => isRecord(change) && typeof change.topic === "string",
		);
		return { t: "changes", changes };
	}
	if (frame.t === "presence" && Array.isArray(frame.places)) {
		const places = frame.places.filter(
			(entry): entry is LivePresencePlace =>
				isRecord(entry) &&
				typeof entry.topic === "string" &&
				Array.isArray(entry.people) &&
				entry.people.every(isPresenceEntry),
		);
		return { t: "presence", places, all: frame.all === true };
	}
	return null;
}

function isPresenceEntry(value: unknown): value is LivePresenceEntry {
	return (
		isRecord(value) &&
		typeof value.userId === "string" &&
		typeof value.name === "string" &&
		typeof value.clientId === "string" &&
		(value.activity === "viewing" || value.activity === "editing")
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
