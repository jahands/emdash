/**
 * Records the site-global reads a page render makes (site settings, menus,
 * widget areas, taxonomy term lists), so the layout prefetch can start the
 * same reads early on later requests for the same route.
 *
 * Each read is stored as a closure that repeats the helper call with the same
 * arguments. Closures must capture only those arguments, never request state:
 * they run again on later requests.
 */

import { getRequestContext, type EmDashRequestContext } from "./request-context.js";

export type LayoutRead = () => Promise<unknown>;

export interface LayoutReadLog {
	/** The context the prefetch warmed. Reads from another context could not use its cache. */
	owner: EmDashRequestContext;
	reads: Map<string, LayoutRead>;
}

let replaying = false;

/**
 * Note that the current render called a layout helper. Call it synchronously
 * at the top of the helper, before its first `await`: replays are recognized
 * only while they run synchronously.
 */
export function noteLayoutRead(id: string, read: LayoutRead): void {
	if (replaying) return;
	const ctx = getRequestContext();
	const log = ctx?.layoutReads;
	if (!log || log.owner !== ctx || log.reads.has(id)) return;
	log.reads.set(id, read);
}

/** Start a recorded read without noting it as a read the render made. */
export function replayLayoutRead(read: LayoutRead): Promise<unknown> {
	replaying = true;
	try {
		return read();
	} finally {
		replaying = false;
	}
}
