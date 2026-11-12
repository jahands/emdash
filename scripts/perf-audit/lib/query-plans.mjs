/**
 * Postgres query plans for the queries that grow with the content: lists,
 * counts, archives and sitemaps. The queries are captured from real
 * requests through the query log, then run again under EXPLAIN ANALYZE on
 * a direct connection.
 */

import { loadPg } from "./deps.mjs";
import { timedRequest } from "./server-pass.mjs";
import { normalizeSql } from "./sql-text.mjs";

export const LARGE_TABLE_ROWS = 10_000;
const READ_SQL = /^\s*(select|with)\b/i;
const COUNT_SQL = /\bcount\s*\(/i;
const SORT_NODES = new Set(["Sort", "Incremental Sort"]);

let counter = 0;

const publicKind = (name) =>
	name.includes("archive") ? "archive" : name.includes("entry") ? "entry" : "list";

/** The requests whose queries are explained, with the kind of query each one stands for. */
export function planRequests({ collection, publicTargets }) {
	const requests = [];
	for (const t of publicTargets) {
		requests.push({
			kind: publicKind(t.name),
			path: t.path,
			auth: false,
		});
	}
	if (collection) {
		requests.push({
			kind: "list",
			path: `/_emdash/api/content/${collection}?limit=20`,
			auth: true,
		});
		requests.push({ kind: "sitemap", path: `/sitemap-${collection}.xml`, auth: false });
	}
	requests.push({ kind: "count", path: "/_emdash/api/dashboard", auth: true });
	requests.push({ kind: "sitemap", path: "/sitemap.xml", auth: false });
	return requests;
}

/** A query's kind: counts are counts wherever they run, the rest take the request's kind. */
export function queryKind(sql, requestKind) {
	return COUNT_SQL.test(sql) ? "count" : requestKind;
}

function walk(node, visit, parent = null) {
	visit(node, parent);
	for (const child of node.Plans ?? []) walk(child, visit, node);
}

/**
 * Flags in an `EXPLAIN (ANALYZE, FORMAT JSON)` plan: sequential scans of
 * tables with at least `threshold` rows (from `pg_class.reltuples`), and
 * sorts that read at least `threshold` rows. Also returns one line per
 * node for the report.
 */
export function planFlags(plan, tableRows, threshold = LARGE_TABLE_ROWS) {
	const flags = [];
	const nodes = [];
	walk(plan.Plan ?? plan, (node) => {
		const type = node["Node Type"];
		const rows = (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
		const relation = node["Relation Name"];
		nodes.push(
			`${type}${relation ? ` on ${relation}` : ""}${node["Index Name"] ? ` using ${node["Index Name"]}` : ""} (${rows} rows)`,
		);
		if (type === "Seq Scan" && relation && (tableRows[relation] ?? 0) >= threshold) {
			flags.push({ kind: "seq scan", relation, tableRows: tableRows[relation] });
		}
		if (SORT_NODES.has(type)) {
			const input = (node.Plans ?? []).reduce(
				(sum, child) => sum + (child["Actual Rows"] ?? 0) * (child["Actual Loops"] ?? 1),
				0,
			);
			if (input >= threshold) {
				flags.push({ kind: "sort", rows: input, method: node["Sort Method"] ?? null });
			}
		}
	});
	return { flags, nodes };
}

/**
 * Capture the read queries of each plan request from the query log and
 * EXPLAIN ANALYZE each distinct one. Returns one record per query.
 */
export async function explainQueries(site, { cookies, requests, threshold = LARGE_TABLE_ROWS }) {
	const captured = new Map();
	for (const request of requests) {
		const phase = `query-plan-${++counter}`;
		const { result } = await timedRequest(site, request.path, {
			cookies: request.auth ? cookies : null,
			phase,
		});
		if (result.status >= 400) continue;
		for (const event of site.queryEvents.filter((e) => e.phase === phase)) {
			if (!READ_SQL.test(event.sql)) continue;
			const sql = normalizeSql(event.sql);
			if (!captured.has(sql)) {
				captured.set(sql, { ...request, event, kind: queryKind(event.sql, request.kind) });
			}
		}
	}
	const { Client } = loadPg();
	const client = new Client({ connectionString: site.directPostgresUrl });
	await client.connect();
	const out = [];
	try {
		const tableRows = Object.fromEntries(
			(
				await client.query(
					"SELECT relname, reltuples::bigint AS rows FROM pg_class WHERE relkind = 'r' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())",
				)
			).rows.map((r) => [r.relname, Number(r.rows)]),
		);
		for (const [sql, { kind, path, event }] of captured) {
			try {
				const result = await client.query(
					`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${event.sql}`,
					event.params ?? [],
				);
				const plan = result.rows[0]["QUERY PLAN"][0];
				const { flags, nodes } = planFlags(plan, tableRows, threshold);
				out.push({
					kind,
					request: path,
					sql,
					executionMs: Math.round(plan["Execution Time"] * 100) / 100,
					planningMs: Math.round(plan["Planning Time"] * 100) / 100,
					flags,
					nodes: nodes.slice(0, 15),
				});
			} catch (error) {
				out.push({ kind, request: path, sql, error: String(error.message).slice(0, 200) });
			}
		}
	} finally {
		await client.end();
	}
	return out.toSorted((a, b) => (b.executionMs ?? 0) - (a.executionMs ?? 0));
}
