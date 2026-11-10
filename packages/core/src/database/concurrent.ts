import type { Kysely } from "kysely";

/**
 * Runs independent statements together, so they cost one round trip. A
 * transaction has a single connection, so inside one they run in order.
 *
 * A failure is rethrown only after every task settles, so no statement is
 * still running when the caller moves on.
 */
export async function runConcurrently<DB, T extends readonly unknown[]>(
	db: Kysely<DB>,
	tasks: readonly [...{ [K in keyof T]: () => Promise<T[K]> }],
): Promise<T> {
	if (db.isTransaction) {
		const results: unknown[] = [];
		for (const task of tasks) {
			// oxlint-disable-next-line no-await-in-loop -- a transaction serializes its statements
			results.push(await task());
		}
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- same order and arity as `tasks`
		return results as unknown as T;
	}
	const settled = await Promise.allSettled(tasks.map((task) => task()));
	const results: unknown[] = [];
	for (const outcome of settled) {
		if (outcome.status === "rejected") throw outcome.reason;
		results.push(outcome.value);
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- same order and arity as `tasks`
	return results as unknown as T;
}
