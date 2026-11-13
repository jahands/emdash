/**
 * Restore bookkeeping. Every measurement starts from the seeded snapshot:
 * once a measurement writes state (declared, or seen in the query log), the
 * next measurement restores first. Each restore is recorded.
 */

const WRITE_SQL = /^\s*(insert|update|delete|replace|create|drop|alter)\b/i;
const CTE_WRITE = /^\s*with\b[\s\S]*\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i;

export function writeStatements(sqlList) {
	return sqlList.filter((sql) => WRITE_SQL.test(sql) || CTE_WRITE.test(sql));
}

export class RestoreLedger {
	constructor(snapshot) {
		this.snapshot = snapshot;
		this.dirtyBy = null;
		this.restores = [];
		this.writes = [];
	}

	get dirty() {
		return this.dirtyBy !== null;
	}

	/** Note what a measurement did. Returns true when it left state dirty. */
	record(measurement, { declaredWrites = false, observedSql = [] } = {}) {
		const observed = writeStatements(observedSql);
		if (!declaredWrites && observed.length === 0) return false;
		this.writes.push({
			measurement,
			declared: declaredWrites,
			statements: observed.length,
			examples: [...new Set(observed.map((s) => s.replace(/\s+/g, " ").slice(0, 120)))].slice(0, 3),
		});
		this.dirtyBy = measurement;
		return true;
	}

	/** Whether `measurement` must restore before it runs. */
	needsRestore() {
		return this.dirty;
	}

	restored(beforeMeasurement, ms) {
		this.restores.push({
			snapshot: this.snapshot,
			before: beforeMeasurement,
			after: this.dirtyBy,
			ms: Math.round(ms),
		});
		this.dirtyBy = null;
	}

	toJSON() {
		return { snapshot: this.snapshot, restores: this.restores, writes: this.writes };
	}
}
