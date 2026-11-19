/**
 * Replay a page's same-origin GET requests one at a time so server work can
 * be attributed to a single request: query count and normalized SQL from
 * the query log, with the statements the request repeated, and on Postgres
 * profiles the round trips and connections seen at the latency proxy,
 * folded into sequential waves.
 */

import { performance } from "node:perf_hooks";

import { cookieHeader } from "./auth.mjs";
import { writeStatements } from "./ledger.mjs";
import { sleep } from "./proc.mjs";
import { queryText } from "./sql-text.mjs";
import { computeWaves } from "./waves.mjs";

let counter = 0;

/** What Chromium sends for a navigation; the server serves HTML documents differently. */
export const DOCUMENT_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

export function eventsForPhase(site, phase) {
	return site.queryEvents.filter((e) => e.phase === phase);
}

const AFTER_QUIET_MS = 500;
const AFTER_MAX_MS = 15_000;

/**
 * Wait for work the server does after responding (`after()`) to finish:
 * until neither the latency proxy nor the commit watcher has seen activity
 * for a while. Returns what happened after `ended`, or null when neither
 * can see this database.
 */
async function afterResponseWork(site, { started, ended, respQueries, commits }) {
	if (!site.proxy && !commits) return null;
	const deadline = performance.now() + AFTER_MAX_MS;
	let lastActivity = ended;
	while (performance.now() < deadline) {
		await sleep(100);
		const queries = site.proxy ? site.proxy.window(started).queries : [];
		const latest = Math.max(
			ended,
			...queries.map((q) => q.end),
			...(commits?.commits ?? []).filter((t) => t > ended),
		);
		if (latest > lastActivity) lastActivity = latest;
		if (performance.now() - lastActivity >= AFTER_QUIET_MS) break;
	}
	const out = { ms: Math.round(Math.max(0, lastActivity - ended)) };
	if (site.proxy) {
		const during = new Set(respQueries);
		out.roundTrips = site.proxy.window(started).queries.filter((q) => !during.has(q)).length;
	}
	if (commits) out.commits = commits.commits.filter((t) => t > ended).length;
	return out;
}

/**
 * Send one request and attribute the server's work to it: TTFB, query count
 * and SQL from the query log, and on Postgres the round trips, waves and
 * connections at the latency proxy. With `watchAfter`, also wait for and
 * record work done after the response.
 */
export async function timedRequest(
	site,
	path,
	{ method = "GET", cookies, json, form, accept = "*/*", phase, watchAfter = false } = {},
) {
	const headers = {
		Accept: accept,
		"x-perf-phase": phase,
		...(cookies ? { Cookie: cookieHeader(cookies) } : {}),
	};
	const init = { method, headers, redirect: "manual" };
	if (method !== "GET") {
		headers["X-EmDash-Request"] = "1";
		headers.Origin = site.origin;
		if (json !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(json);
		} else if (form) {
			init.body = form;
		}
	}
	const commits = watchAfter ? site.watchCommits() : null;
	const started = performance.now();
	let response;
	let text;
	let headersAt;
	let ended;
	try {
		response = await fetch(`${site.origin}${path}`, init);
		headersAt = performance.now();
		text = await response.text();
		ended = performance.now();
	} catch (error) {
		commits?.stop();
		throw error;
	}
	const respQueries = site.proxy ? site.proxy.window(started, ended).queries : [];
	let after = null;
	try {
		after = watchAfter
			? await afterResponseWork(site, { started, ended, respQueries, commits })
			: (await sleep(150), null);
	} finally {
		commits?.stop();
	}
	const events = eventsForPhase(site, phase);
	const out = {
		path,
		status: response.status,
		ttfbMs: Math.round(headersAt - started),
		totalMs: Math.round(ended - started),
		queries: events.length,
		writes: writeStatements(events.map((e) => e.sql)).length,
		...queryText(events),
	};
	if (method !== "GET") out.method = method;
	if (site.proxy) {
		out.dbRoundTrips = respQueries.length;
		out.dbWaves = computeWaves(respQueries).waves;
		out.dbConnections = site.proxy.window(started, ended).connections.length;
	}
	if (watchAfter) out.afterResponse = after;
	let data = null;
	try {
		data = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { result: out, data, text };
}

export async function replayRequest(site, path, { cookies, accept = "*/*" } = {}) {
	const phase = `server-pass-${++counter}`;
	return (await timedRequest(site, path, { cookies, accept, phase })).result;
}

/** Replay the unique GET document and API requests a page load made. */
export async function serverPass(site, pageResult, { cookies, cache }) {
	const paths = [];
	const documents = new Set();
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
		if (r.type === "Document") documents.add(path);
		if (!paths.includes(path)) paths.push(path);
	}
	const results = [];
	for (const path of paths) {
		const key = `${cookies ? "auth" : "anon"} ${path}`;
		const accept = documents.has(path) ? DOCUMENT_ACCEPT : undefined;
		if (!cache.has(key)) cache.set(key, await replayRequest(site, path, { cookies, accept }));
		results.push(cache.get(key));
	}
	return results;
}
