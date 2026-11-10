import type { Kysely, KyselyPlugin, QueryId } from "kysely";

import type { Database } from "../../src/database/types.js";

interface RecordedQuery {
	sql: string;
	startedAt: number;
	endedAt: number | null;
}

export interface QueryRecorder {
	/** Same database, with every statement issued through it recorded. */
	db: Kysely<Database>;
	/** SQL text of each statement since the last `reset`, in the order issued. */
	queries(): string[];
	/** Statements matching `pattern`. */
	matching(pattern: RegExp): string[];
	/** How many groups of overlapping statements ran, one round trip each. */
	waves(): number;
	/** The most statements that were in flight at once. */
	peakConcurrency(): number;
	reset(): void;
}

/**
 * Records every statement a code path issues and how they overlap, so a test
 * can pin its round trips the way `pnpm perf:audit` counts them.
 *
 * Time is a logical tick, so overlap reflects issue order rather than how fast
 * this machine is.
 */
export function recordQueries(source: Kysely<Database>): QueryRecorder {
	const queries = new Map<QueryId, RecordedQuery>();
	let tick = 0;
	const plugin: KyselyPlugin = {
		transformQuery({ node, queryId }) {
			queries.set(queryId, {
				sql: source.getExecutor().compileQuery(node, queryId).sql,
				startedAt: ++tick,
				endedAt: null,
			});
			return node;
		},
		async transformResult({ queryId, result }) {
			const query = queries.get(queryId);
			if (query) query.endedAt = ++tick;
			return result;
		},
	};

	const ordered = () => [...queries.values()].toSorted((a, b) => a.startedAt - b.startedAt);

	return {
		db: source.withPlugin(plugin),
		queries: () => ordered().map((query) => query.sql),
		matching: (pattern) =>
			ordered()
				.filter((query) => pattern.test(query.sql))
				.map((query) => query.sql),
		waves: () => {
			let waves = 0;
			let waveEnd = 0;
			for (const query of ordered()) {
				const endedAt = query.endedAt ?? Number.POSITIVE_INFINITY;
				if (query.startedAt > waveEnd) {
					waves++;
					waveEnd = endedAt;
				} else {
					waveEnd = Math.max(waveEnd, endedAt);
				}
			}
			return waves;
		},
		peakConcurrency: () => {
			let peak = 0;
			const list = ordered();
			for (const query of list) {
				const end = query.endedAt ?? Number.POSITIVE_INFINITY;
				const overlapping = list.filter(
					(other) =>
						other.startedAt <= end &&
						(other.endedAt ?? Number.POSITIVE_INFINITY) >= query.startedAt,
				).length;
				peak = Math.max(peak, overlapping);
			}
			return peak;
		},
		reset: () => {
			queries.clear();
			tick = 0;
		},
	};
}
