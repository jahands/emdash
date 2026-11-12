/**
 * Learned prefetch of site-global "chrome" data for public pages.
 *
 * The layout reads site settings, menus, widget areas and taxonomy term lists
 * from separately rendered components, so on a remote backend the reads
 * serialize. Starting them concurrently at the beginning of the request lets
 * them overlap, and the results land in the per-request `requestCached` store
 * under the keys the helpers use, so the components find them warm.
 *
 * Only reads the page is known to make are started. Each render records the
 * layout helpers it called (see `layout-reads.ts`); later requests for the
 * same route start those reads. A route that has not rendered yet starts the
 * reads every finished render so far has made. A read that was started but
 * not used is never started again for that route. So the prefetch issues no
 * query the page would not issue itself, except at most once per route and
 * read in an isolate.
 */

import type { LayoutRead, LayoutReadLog } from "../layout-reads.js";
import { replayLayoutRead } from "../layout-reads.js";
import type { EmDashRequestContext } from "../request-context.js";
import { wrapResponseForScopedClose } from "./middleware/scoped-db.js";

interface RouteReads {
	reads: Map<string, LayoutRead>;
	rejected: Set<string>;
}

interface PrefetchState {
	routes: Map<string, RouteReads>;
	/** Reads every finished render has made, or null before the first one. */
	common: Map<string, LayoutRead> | null;
}

const STATE_KEY = Symbol.for("emdash:layout-prefetch");
const g = globalThis as Record<symbol, unknown>;
const state: PrefetchState =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see request-context.ts)
	(g[STATE_KEY] as PrefetchState | undefined) ??
	(() => {
		const initial: PrefetchState = { routes: new Map(), common: null };
		g[STATE_KEY] = initial;
		return initial;
	})();

export interface LayoutPrefetch {
	/** Learn from the render once the response body has been sent in full. */
	trackResponse(response: Response): Response;
	/** Settles when the started reads have. */
	settled: Promise<unknown>;
}

function candidateReads(route: string): Array<[string, LayoutRead]> {
	const known = state.routes.get(route);
	const source = known?.reads ?? state.common;
	if (!source) return [];
	return [...source].filter(([id]) => !known?.rejected.has(id));
}

function learn(route: string, log: LayoutReadLog, started: Set<string>, ok: boolean): void {
	let known = state.routes.get(route);
	if (!known) {
		known = { reads: new Map(), rejected: new Set() };
		state.routes.set(route, known);
	}
	for (const id of started) {
		if (log.reads.has(id)) continue;
		known.reads.delete(id);
		known.rejected.add(id);
	}
	if (!ok) return;
	for (const [id, read] of log.reads) {
		if (!known.rejected.has(id)) known.reads.set(id, read);
	}
	if (state.common === null) {
		state.common = new Map(log.reads);
	} else {
		for (const id of state.common.keys()) {
			if (!log.reads.has(id)) state.common.delete(id);
		}
	}
}

/**
 * Start the layout reads learned for `route` and record what this render
 * reads. Call inside the request ALS frame that owns `ctx`, before rendering.
 * Never throws: a failed read is left for the helper to run on demand.
 */
export function startLayoutPrefetch(ctx: EmDashRequestContext, route: string): LayoutPrefetch {
	const log: LayoutReadLog = { owner: ctx, reads: new Map() };
	ctx.layoutReads = log;

	const started = new Set<string>();
	const pending: Promise<unknown>[] = [];
	for (const [id, read] of candidateReads(route)) {
		started.add(id);
		try {
			pending.push(replayLayoutRead(read).catch(() => undefined));
		} catch {
			// The helper runs on demand.
		}
	}

	let learned = false;
	const finish = (ok: boolean) => {
		if (learned) return;
		learned = true;
		learn(route, log, started, ok);
	};

	return {
		settled: Promise.all(pending),
		trackResponse(response) {
			// A cancelled stream also finishes. Its render may have stopped early,
			// which can only reject reads, never add one the page did not make.
			const ok = response.status >= 200 && response.status < 300;
			return wrapResponseForScopedClose(response, () => finish(ok));
		},
	};
}

/** @internal */
export function resetLayoutPrefetchForTests(): void {
	state.routes.clear();
	state.common = null;
}
