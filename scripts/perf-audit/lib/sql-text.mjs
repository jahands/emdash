/**
 * Query text kept from the query log, normalized the way
 * `scripts/query-counts` normalizes it, and the queries a request repeated.
 */

import { normalizeSql } from "../../query-counts-normalize.mjs";

export { normalizeSql };

const TRANSACTION_CONTROL = /^\s*(begin|commit|rollback|savepoint|release|start transaction)\b/i;

/**
 * Statements a request ran more than once, by normalized text, most
 * repeated first. `sameParams` is how many of those runs had identical
 * parameters too: those repeated the same work, while the rest read the
 * same shape for different rows (an N+1 pattern).
 */
export function duplicateQueries(events) {
	const byText = new Map();
	for (const event of events) {
		if (TRANSACTION_CONTROL.test(event.sql)) continue;
		const sql = normalizeSql(event.sql);
		const entry = byText.get(sql) ?? { sql, count: 0, params: new Map() };
		entry.count++;
		const key = JSON.stringify(event.params ?? []);
		entry.params.set(key, (entry.params.get(key) ?? 0) + 1);
		byText.set(sql, entry);
	}
	return [...byText.values()]
		.filter((e) => e.count > 1)
		.map((e) => {
			const most = Math.max(...e.params.values());
			return { sql: e.sql, count: e.count, sameParams: most > 1 ? most : 0 };
		})
		.toSorted((a, b) => b.count - a.count || b.sameParams - a.sameParams);
}

/** Normalized text of each statement, in order, and the repeated ones. */
export function queryText(events) {
	return { sql: events.map((e) => normalizeSql(e.sql)), duplicates: duplicateQueries(events) };
}
