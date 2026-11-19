/**
 * The tab's one socket to the site's realtime hub. It gets a ticket from the server, tells the
 * hub which topics the tab shows and where the tab is, and reports the changes and rosters the
 * hub sends. It stays open for five minutes in a hidden tab, because a hibernated socket costs
 * nothing and every reconnect makes the tab refetch, and reconnects with jitter so a deploy
 * doesn't bring every tab back at once. Near the end of a socket's lifetime, when the hub asks or
 * the tab's own timer fires, the tab opens the next one and closes the old one once the hub says
 * over it that the new one has the topics, so nothing is missed and nothing needs refetching.
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
	/**
	 * The hub has the tab's topics again after a gap, as of `since`, in ms. A read that started
	 * before then may have missed a change.
	 */
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
/** How long the hub keeps a socket open when the ticket doesn't say. */
const DEFAULT_LIFETIME_MS = 15 * 60_000;
/** A socket renews about this long before its lifetime ends, give or take half of it. */
const RENEW_BEFORE_MS = 60_000;
/** Renewing after the hub asks leaves at least this long before the socket closes. */
const RENEW_MARGIN_MS = 15_000;
/** A hub from before the handoff never sends one; the tab then moves over without it. */
const HANDOFF_WAIT_MS = 5000;

type Target = { url: string; ticket: string; lifetime: number };

export function openLiveConnection(events: LiveConnectionEvents): LiveConnection {
	let topics: readonly string[] = [];
	let place: LivePlace | null = null;
	let socket: WebSocket | null = null;
	/** The socket replacing `socket`, until the hub confirms its topics. */
	let renewing: WebSocket | null = null;
	let renewRequested = false;
	/** Closed by the tab after a renewal, so their close reconnects nothing. */
	const retired = new WeakSet<WebSocket>();
	let connecting = false;
	let stopped = false;
	/** Closed while the tab was hidden; it reopens when the tab shows again. */
	let paused = false;
	/** An open socket closed, so changes may have been missed until the hub has the topics again. */
	let missed = false;
	let lifetime = DEFAULT_LIFETIME_MS;
	/** When each socket opened. */
	const openedAt = new WeakMap<WebSocket, number>();
	/** Sockets whose topics the hub has answered. */
	const acked = new WeakSet<WebSocket>();
	let renewTimer: number | undefined;
	let renewAt = Number.POSITIVE_INFINITY;
	let handoffTimer: number | undefined;
	let failures = 0;
	let attempt = 0;
	let retryTimer: number | undefined;
	let hiddenTimer: number | undefined;

	function sendTopics(ws: WebSocket | null): void {
		if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "topics", topics }));
	}

	function sendPlace(ws: WebSocket | null): void {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({ t: "here", topic: place?.topic ?? null, activity: place?.activity }),
			);
		}
	}

	async function connect(): Promise<void> {
		retryTimer = undefined;
		if (stopped || paused || socket || renewing || connecting) return;
		connecting = true;
		let target: Target | "off" | null;
		try {
			target = await fetchTicket();
		} finally {
			connecting = false;
		}
		if (stopped || paused || socket || renewing) return;
		if (target === "off") stop();
		else if (target) open(target, false);
		else retryIn(backoff());
	}

	/** Renews `socket` at `at`, in ms, unless it already renews sooner. */
	function renewAtOrBefore(at: number): void {
		if (at >= renewAt) return;
		window.clearTimeout(renewTimer);
		renewAt = at;
		renewTimer = window.setTimeout(
			() => {
				renewAt = Number.POSITIVE_INFINITY;
				void renew();
			},
			Math.max(0, at - Date.now()),
		);
	}

	function cancelRenewal(): void {
		window.clearTimeout(renewTimer);
		renewAt = Number.POSITIVE_INFINITY;
	}

	/** The time `ws` reaches the end of its lifetime. */
	function endOf(ws: WebSocket): number {
		return (openedAt.get(ws) ?? Date.now()) + lifetime;
	}

	/** Opens the socket that replaces the current one. A failed ticket leaves it to expire. */
	async function renew(): Promise<void> {
		if (renewRequested || renewing || stopped || paused || !socket) return;
		renewRequested = true;
		let target: Target | "off" | null;
		try {
			target = await fetchTicket();
		} finally {
			renewRequested = false;
		}
		if (target && target !== "off" && !stopped && !paused && !renewing) open(target, true);
	}

	/** Makes the renewing socket the tab's socket. */
	function promote(ws: WebSocket): void {
		window.clearTimeout(handoffTimer);
		renewing = null;
		const old = socket;
		socket = ws;
		if (old) {
			retired.add(old);
			old.close(1000, "Renewed");
		}
		cancelRenewal();
		renewAtOrBefore(endOf(ws) - RENEW_BEFORE_MS * (0.5 + Math.random()));
		if (missed && acked.has(ws)) {
			missed = false;
			events.resync(Date.now());
		}
	}

	function open(target: Target, renewal: boolean): void {
		lifetime = target.lifetime;
		const ws = new WebSocket(socketUrl(target));
		if (renewal) renewing = ws;
		else socket = ws;
		let opened = false;
		let pingTimer: number | undefined;
		ws.addEventListener("open", () => {
			opened = true;
			attempt = 0;
			openedAt.set(ws, Date.now());
			if (!renewal) renewAtOrBefore(endOf(ws) - RENEW_BEFORE_MS * (0.5 + Math.random()));
			sendTopics(ws);
			if (place) sendPlace(ws);
			pingTimer = window.setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send("ping");
			}, PING_MS);
		});
		ws.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data === "pong") return;
			failures = 0;
			const frame = readFrame(event.data);
			if (frame?.t === "changes" && frame.changes.length > 0) events.changes(frame.changes);
			else if (frame?.t === "presence") {
				// The hub answers a socket's topics with every roster under them, once they're in effect.
				if (frame.all) acked.add(ws);
				if (frame.all && ws === renewing) {
					window.clearTimeout(handoffTimer);
					handoffTimer = window.setTimeout(() => {
						if (renewing !== ws) return;
						// Without a handoff, changes may have gone only to the old socket meanwhile.
						missed = true;
						promote(ws);
					}, HANDOFF_WAIT_MS);
				}
				if (frame.all && ws === socket && missed) {
					missed = false;
					events.resync(Date.now());
				}
				events.presence(frame.places, frame.all);
			} else if (frame?.t === "handoff" && ws === socket) {
				if (renewing?.readyState === WebSocket.OPEN) promote(renewing);
			} else if (frame?.t === "renew" && ws === socket) {
				// Spread out over what is left, as the hub asks every socket near its end at once.
				const left = Math.max(0, endOf(ws) - RENEW_MARGIN_MS - Date.now());
				renewAtOrBefore(Date.now() + Math.random() * left);
			}
		});
		ws.addEventListener("close", (event) => {
			window.clearInterval(pingTimer);
			if (retired.has(ws)) return;
			if (ws === renewing) {
				window.clearTimeout(handoffTimer);
				renewing = null;
				if (!socket && !stopped && !paused) retryIn(backoff());
				return;
			}
			if (socket === ws) {
				socket = null;
				cancelRenewal();
			}
			if (opened) {
				missed = true;
				// Rosters stop reaching a closed socket, so what the tab knows would go stale.
				events.presence([], true);
			}
			if (stopped || paused) return;
			if (renewing) {
				if (renewing.readyState === WebSocket.OPEN) promote(renewing);
				return;
			}
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
				cancelRenewal();
				retireRenewing();
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
		if (socket || renewing || stopped || paused) return;
		window.clearTimeout(retryTimer);
		void connect();
	}

	function stop(): void {
		stopped = true;
		window.clearTimeout(retryTimer);
		window.clearTimeout(hiddenTimer);
		window.clearTimeout(handoffTimer);
		cancelRenewal();
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("online", onOnline);
		const ws = socket;
		socket = null;
		ws?.close(1000, "Live updates stopped");
		retireRenewing();
	}

	function retireRenewing(): void {
		const ws = renewing;
		renewing = null;
		if (!ws) return;
		retired.add(ws);
		ws.close(1000, "Live updates stopped");
	}

	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("online", onOnline);
	void connect();

	return {
		setTopics(next) {
			topics = next;
			sendTopics(socket);
			sendTopics(renewing);
		},
		setPlace(next) {
			if (next?.topic === place?.topic && next?.activity === place?.activity) return;
			place = next;
			sendPlace(socket);
			sendPlace(renewing);
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
			const lifetime =
				typeof data.lifetime === "number" && data.lifetime > 0
					? data.lifetime
					: DEFAULT_LIFETIME_MS;
			return { url: data.url, ticket: data.ticket, lifetime };
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
	| { t: "presence"; places: LivePresencePlace[]; all: boolean }
	| { t: "renew" }
	| { t: "handoff" };

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
	if (frame.t === "renew") return { t: "renew" };
	if (frame.t === "handoff") return { t: "handoff" };
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
