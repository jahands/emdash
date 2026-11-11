/**
 * Replay a page's same-origin GET requests one at a time so server work can
 * be attributed to a single request: query count and SQL from the query
 * log, and on Postgres profiles the round trips and connections seen at the
 * latency proxy, folded into sequential waves.
 */

import { performance } from "node:perf_hooks";

import { cookieHeader } from "./auth.mjs";
import { writeStatements } from "./ledger.mjs";
import { sleep } from "./proc.mjs";
import { computeWaves } from "./waves.mjs";

let counter = 0;

export function eventsForPhase(site, phase) {
	return site.queryEvents.filter((e) => e.phase === phase);
}

export async function replayRequest(site, path, { cookies, accept = "*/*" } = {}) {
	const phase = `server-pass-${++counter}`;
	const started = performance.now();
	const response = await fetch(`${site.origin}${path}`, {
		headers: {
			Accept: accept,
			"x-perf-phase": phase,
			...(cookies ? { Cookie: cookieHeader(cookies) } : {}),
		},
		redirect: "manual",
	});
	const headersAt = performance.now();
	await response.arrayBuffer();
	const ended = performance.now();
	await sleep(150);
	const events = eventsForPhase(site, phase);
	const out = {
		path,
		status: response.status,
		ttfbMs: Math.round(headersAt - started),
		totalMs: Math.round(ended - started),
		queries: events.length,
		writes: writeStatements(events.map((e) => e.sql)).length,
		sql: events.map((e) => e.sql),
	};
	if (site.proxy) {
		const window = site.proxy.window(started, ended);
		out.dbRoundTrips = window.queries.length;
		out.dbWaves = computeWaves(window.queries).waves;
		out.dbConnections = window.connections.length;
	}
	return out;
}

/** Replay the unique GET document and API requests a page load made. */
export async function serverPass(site, pageResult, { cookies, cache }) {
	const paths = [];
	for (const r of pageResult.waterfall) {
		if (r.status === null || r.status >= 300 || r.method === "POST") continue;
		let url;
		try {
			url = new URL(r.url);
		} catch {
			continue;
		}
		if (url.origin !== site.origin) continue;
		const path = url.pathname + url.search;
		const isApi = url.pathname.startsWith("/_emdash/api/");
		if (r.type !== "Document" && !isApi) continue;
		if (!paths.includes(path)) paths.push(path);
	}
	const results = [];
	for (const path of paths) {
		const key = `${cookies ? "auth" : "anon"} ${path}`;
		if (!cache.has(key)) cache.set(key, await replayRequest(site, path, { cookies }));
		results.push(cache.get(key));
	}
	return results;
}
