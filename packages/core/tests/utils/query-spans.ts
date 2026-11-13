import type {
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";

export interface QuerySpan {
	start: number;
	end: number;
	tables: string[];
}

/**
 * Records when each query starts and finishes, on a logical clock. Queries
 * issued together overlap even on SQLite, where the connection runs them one
 * at a time, so the spans show what a remote database would run concurrently.
 */
export class QuerySpans implements KyselyPlugin {
	#clock = 0;
	#open = new Map<unknown, Omit<QuerySpan, "end">>();
	spans: QuerySpan[] = [];

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		const tables = new Set<string>();
		JSON.stringify(args.node, (_key, value: unknown) => {
			if (isTableNode(value)) tables.add(value.table.identifier.name);
			return value;
		});
		this.#open.set(args.queryId, { start: ++this.#clock, tables: [...tables] });
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		const open = this.#open.get(args.queryId);
		if (open) this.spans.push({ ...open, end: ++this.#clock });
		return Promise.resolve(args.result);
	}
}

function isTableNode(value: unknown): value is { table: { identifier: { name: string } } } {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "TableNode" &&
		"table" in value
	);
}

/** The longest chain of queries where each one starts after the previous ended. */
export function sequentialWaves(spans: QuerySpan[]): number {
	const sorted = spans.toSorted((a, b) => a.start - b.start);
	const waves = sorted.map(() => 1);
	for (let i = 0; i < sorted.length; i++) {
		for (let j = 0; j < i; j++) {
			if (sorted[j]!.end <= sorted[i]!.start) waves[i] = Math.max(waves[i]!, waves[j]! + 1);
		}
	}
	return Math.max(0, ...waves);
}
