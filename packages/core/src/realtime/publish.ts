/**
 * Tells admin tabs what changed, through the realtime hub. Writers call `publishChange` beside
 * `notifyRoom`. Inside the outermost `withTransaction`, changes wait until it commits and are
 * dropped if it throws, so no tab refetches before a write is visible. Each flush sends one batch
 * with `after()`. Publishing runs no query and does nothing while no publisher is set.
 *
 * Shared code may import this module, so it must stay free of the hub and the database.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { after } from "../after.js";

export type ChangeOp = "create" | "update" | "delete";

/** A message never carries data: tabs refetch through the routes, which check access. */
export interface Change {
	topic: string;
	/** The rows that changed. Absent when the whole topic may have changed. */
	ids?: string[];
	op?: ChangeOp;
	/** The tab whose request made the change, which skips it. */
	origin?: string;
}

export interface ChangePublisher {
	/** Never awaited by a writer. */
	publish(changes: Change[]): Promise<void>;
}

/** The header the admin sends with its tab's ID. */
export const CLIENT_HEADER = "X-EmDash-Client";

/** Past this, a merged change drops its IDs, which means the whole topic. */
const MAX_IDS = 50;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface ChangeQueue {
	/** Keyed by origin and topic. */
	held: Map<string, Change>;
	closed: boolean;
	parent: ChangeQueue | undefined;
}

interface PublishState {
	publisher: ChangePublisher | null;
	queues: AsyncLocalStorage<ChangeQueue>;
	origins: AsyncLocalStorage<string>;
}

const STATE_KEY = Symbol.for("emdash:realtime:publish");
const store = globalThis as Record<symbol, unknown>;

function state(): PublishState {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let current = store[STATE_KEY] as PublishState | undefined;
	if (!current) {
		current = {
			publisher: null,
			queues: new AsyncLocalStorage(),
			origins: new AsyncLocalStorage(),
		};
		store[STATE_KEY] = current;
	}
	return current;
}

/** Sets where changes go. With none, every function here does nothing. */
export function setChangePublisher(publisher: ChangePublisher | null): void {
	state().publisher = publisher;
}

/** Clears the slot only while it holds this publisher, so an older host never clears a newer one. */
export function clearChangePublisher(publisher: ChangePublisher): void {
	const current = state();
	if (current.publisher === publisher) current.publisher = null;
}

/** Whether a `X-EmDash-Client` header holds a tab ID. */
export function isClientId(value: string | null): value is string {
	return value !== null && CLIENT_ID.test(value);
}

/**
 * Runs `fn` with changes it publishes marked as made by the tab `clientId`, which is the
 * `X-EmDash-Client` header. A missing or malformed ID marks nothing.
 */
export function withChangeOrigin<T>(clientId: string | null, fn: () => T): T {
	if (!isClientId(clientId)) return fn();
	return state().origins.run(clientId, fn);
}

/** Tells the hub `topic` changed. Waits in the innermost open queue, or goes out at once. */
export function publishChange(topic: string, change: { ids?: string[]; op?: ChangeOp } = {}): void {
	const { publisher, queues, origins } = state();
	if (!publisher) return;
	const queued: Change = { topic };
	if (change.ids) queued.ids = [...new Set(change.ids)].slice(0, MAX_IDS + 1);
	if (queued.ids && queued.ids.length > MAX_IDS) delete queued.ids;
	if (change.op) queued.op = change.op;
	const origin = origins.getStore();
	if (origin) queued.origin = origin;
	const queue = openQueue(queues.getStore());
	if (queue) hold(queue, queued);
	else send([queued]);
}

/**
 * Runs `run` with its changes held until it settles. If it resolves, they go to the queue around
 * it, or out as one batch; if it throws, they are dropped. Opens nothing while no publisher is set.
 */
export async function withChangeQueue<T>(run: () => Promise<T>): Promise<T> {
	const { publisher, queues } = state();
	if (!publisher) return run();
	const queue: ChangeQueue = {
		held: new Map(),
		closed: false,
		parent: openQueue(queues.getStore()),
	};
	let committed = false;
	try {
		const result = await queues.run(queue, run);
		committed = true;
		return result;
	} finally {
		queue.closed = true;
		if (committed) flush(queue);
		queue.held.clear();
	}
}

/** Work deferred past its queue's end still runs in that queue's context. */
function openQueue(queue: ChangeQueue | undefined): ChangeQueue | undefined {
	let current = queue;
	while (current?.closed) current = current.parent;
	return current;
}

function hold(queue: ChangeQueue, change: Change): void {
	const key = `${change.origin ?? ""}\n${change.topic}`;
	const held = queue.held.get(key);
	queue.held.set(key, held ? merge(held, change) : change);
}

function merge(a: Change, b: Change): Change {
	const merged: Change = { topic: a.topic };
	if (a.ids && b.ids) {
		const ids = [...new Set([...a.ids, ...b.ids])];
		if (ids.length <= MAX_IDS) merged.ids = ids;
	}
	if (a.op === b.op && a.op) merged.op = a.op;
	if (a.origin) merged.origin = a.origin;
	return merged;
}

function flush(queue: ChangeQueue): void {
	const parent = openQueue(queue.parent);
	if (parent) {
		for (const change of queue.held.values()) hold(parent, change);
		return;
	}
	if (queue.held.size > 0) send([...queue.held.values()]);
}

/** Never awaited: the writer doesn't wait for the hub. */
function send(changes: Change[]): void {
	after(async () => {
		try {
			await state().publisher?.publish(changes);
		} catch (error) {
			console.error("[realtime] couldn't publish changes:", error);
		}
	});
}
