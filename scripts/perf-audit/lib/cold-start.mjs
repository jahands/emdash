/**
 * Cold starts: restart the runtime, then time the first request.
 */

import { performance } from "node:perf_hooks";

import { cookieHeader } from "./auth.mjs";

async function timeFirstRequest(site, path, cookies) {
	const restartStarted = performance.now();
	await site.stop();
	await site.start();
	const bootMs = performance.now() - restartStarted;
	const started = performance.now();
	let response;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			response = await fetch(`${site.origin}${path}`, {
				headers: {
					"x-perf-phase": "cold-start",
					...(cookies ? { Cookie: cookieHeader(cookies) } : {}),
				},
				redirect: "manual",
			});
			break;
		} catch (error) {
			if (attempt === 19) throw error;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	const ttfb = performance.now() - started;
	await response.arrayBuffer();
	const total = performance.now() - started;
	return {
		path,
		status: response.status,
		restartMs: Math.round(bootMs),
		ttfbMs: Math.round(ttfb),
		totalMs: Math.round(total),
	};
}

export async function measureColdStarts(site, cookies) {
	return {
		publicPage: await timeFirstRequest(site, "/"),
		adminApi: await timeFirstRequest(site, "/_emdash/api/auth/me", cookies),
	};
}
