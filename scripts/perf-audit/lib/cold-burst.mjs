/**
 * Cold-start bursts: restart the runtime, then send many requests at once,
 * the way traffic reaches a freshly started isolate after a deploy or a
 * scale-out. Any response that is not 2xx or 3xx fails the check.
 *
 * Workerd answers a request it cancelled with a 500 and logs nothing, so
 * the failures are read from the responses, not from the server output.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { cookieHeader } from "./auth.mjs";
import { sleep } from "./proc.mjs";

export const MIN_BURST_REQUESTS = 15;
const REQUEST_TIMEOUT_MS = 30_000;
const BODY_EXCERPT = 160;

const ADMIN_API_PATHS = [
	"/_emdash/api/auth/me",
	"/_emdash/api/manifest",
	"/_emdash/api/dashboard",
	"/_emdash/api/media?limit=50",
	"/_emdash/api/taxonomies",
	"/_emdash/api/menus",
	"/_emdash/api/settings",
];

function repeatTo(paths, min) {
	if (paths.length === 0) return [];
	const copies = Math.ceil(min / paths.length);
	return Array.from({ length: copies }).fill(paths).flat();
}

/**
 * The requests in each burst: the public pages signed out, and the admin
 * API signed in, each repeated to at least `min` requests.
 */
export function burstPlan({ publicPaths, collection, min = MIN_BURST_REQUESTS }) {
	const adminPaths = [...ADMIN_API_PATHS];
	if (collection) adminPaths.push(`/_emdash/api/content/${collection}?limit=20`);
	const signedOut = repeatTo(publicPaths, min).map((path) => ({ path, signedIn: false }));
	const signedIn = repeatTo(adminPaths, min).map((path) => ({ path, signedIn: true }));
	const mixed = [];
	for (let i = 0; i < Math.max(signedOut.length, signedIn.length); i++) {
		if (signedOut[i]) mixed.push(signedOut[i]);
		if (signedIn[i]) mixed.push(signedIn[i]);
	}
	return [
		{ name: "signed out", requests: signedOut },
		{ name: "signed out and admin API", requests: mixed },
	];
}

/** A response fails the burst unless it is 2xx or 3xx. */
export function isFailedStatus(status) {
	return !(status >= 200 && status < 400);
}

async function send(origin, { path, signedIn }, cookies) {
	const started = performance.now();
	try {
		const response = await fetch(`${origin}${path}`, {
			headers: {
				Accept: signedIn ? "application/json" : "text/html",
				"x-perf-phase": "cold-burst",
				...(signedIn && cookies ? { Cookie: cookieHeader(cookies) } : {}),
			},
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.text();
		const out = {
			path,
			signedIn,
			status: response.status,
			ms: Math.round(performance.now() - started),
		};
		if (isFailedStatus(response.status)) out.body = body.slice(0, BODY_EXCERPT);
		return out;
	} catch (error) {
		return {
			path,
			signedIn,
			status: 0,
			ms: Math.round(performance.now() - started),
			error: String(error?.cause?.code ?? error?.name ?? error).slice(0, BODY_EXCERPT),
		};
	}
}

/** A built client asset. Host config files such as `_headers` are not served, so the runtime would answer them. */
export function staticAssetPath(siteDir) {
	try {
		const file = readdirSync(join(siteDir, "dist/client/_astro"), { withFileTypes: true }).find(
			(e) => e.isFile(),
		);
		return file ? `/_astro/${file.name}` : null;
	} catch {
		return null;
	}
}

/**
 * Wait until the server answers without sending a request through the
 * runtime: a static file is served before EmDash's middleware, so the
 * runtime is still cold when the burst arrives.
 */
async function waitUntilServing(site) {
	const asset = staticAssetPath(site.siteDir);
	if (!asset) throw new Error(`No built client asset in ${site.siteDir} to check the server with`);
	for (let attempt = 0; attempt < 50; attempt++) {
		try {
			const response = await fetch(`${site.origin}${asset}`, { redirect: "manual" });
			await response.arrayBuffer();
			return;
		} catch {
			await sleep(100);
		}
	}
}

/**
 * Run every burst `rounds` times, restarting the runtime before each one.
 * `site` needs `origin`, `stop()` and `start()`, and `siteDir` for the
 * readiness check.
 */
export async function measureColdBursts(site, { plan, cookies, rounds = 2 }) {
	const bursts = [];
	for (let round = 0; round < rounds; round++) {
		for (const burst of plan) {
			await site.stop();
			await site.start();
			await waitUntilServing(site);
			const responses = await Promise.all(burst.requests.map((r) => send(site.origin, r, cookies)));
			const failed = responses.filter((r) => isFailedStatus(r.status));
			bursts.push({
				name: burst.name,
				round,
				requests: responses.length,
				signedOut: responses.filter((r) => !r.signedIn).length,
				signedIn: responses.filter((r) => r.signedIn).length,
				failed,
				maxMs: Math.max(...responses.map((r) => r.ms)),
			});
		}
	}
	return {
		rounds,
		requests: bursts.reduce((n, b) => n + b.requests, 0),
		failedRequests: bursts.reduce((n, b) => n + b.failed.length, 0),
		bursts,
	};
}
