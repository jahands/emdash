/**
 * Decides which measurements changed stored state, so the next measurement can
 * start from the seeded database instead of whatever an earlier one left.
 */

const WRITE_STATEMENT =
	/^\s*(?:insert|update|delete|replace|create|alter|drop)\b|^\s*with\b[\s\S]*\b(?:insert|update|delete)\b/i;
const WRITE_TARGET =
	/^\s*(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from|replace\s+into|(?:create|alter|drop)\s+(?:unique\s+)?(?:table|index|view|trigger)(?:\s+if\s+(?:not\s+)?exists)?)\s+["`]?([\w.]+)/i;

/**
 * Tables that page loads write to as bookkeeping, without changing what a later
 * measurement shows: opening the editor takes the audit user's own entry lock.
 */
export const BOOKKEEPING_TABLES = new Set(["_emdash_entry_locks"]);

/** Returns the statements in a measurement's query log that change stored content. */
export function contentWrites(events) {
	return events.filter((event) => {
		const sql = event.rawSql ?? event.sql;
		if (!WRITE_STATEMENT.test(sql)) return false;
		const table = WRITE_TARGET.exec(sql)?.[1]?.split(".").at(-1);
		return !table || !BOOKKEEPING_TABLES.has(table);
	});
}

/** Names the tables a list of write statements touched, for reporting. */
export function writtenTables(events) {
	return [
		...new Set(
			events.map(
				(event) =>
					WRITE_TARGET.exec(event.rawSql ?? event.sql)?.[1]
						?.split(".")
						.at(-1) ?? "?",
			),
		),
	].toSorted((a, b) => a.localeCompare(b));
}
