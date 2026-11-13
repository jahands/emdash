/**
 * Await every promise, then throw the first rejection.
 *
 * Unlike `Promise.all`, this never returns while another query is still in
 * flight: a rejected query cannot leave its siblings holding pooled
 * connections after the caller has moved on (or after a request-scoped pool
 * starts closing).
 */
export async function settleAll<const T extends readonly unknown[]>(
	promises: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
	const results = await Promise.allSettled(promises);
	const values: unknown[] = [];
	for (const result of results) {
		if (result.status === "rejected") throw result.reason;
		values.push(result.value);
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- allSettled preserves input order and arity
	return values as { -readonly [K in keyof T]: Awaited<T[K]> };
}
