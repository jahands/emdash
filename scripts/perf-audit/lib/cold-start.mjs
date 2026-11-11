/**
 * Cold starts: restart the runtime, then time the first request.
 */

import { performance } from "node:perf_hooks";

import { cookieHeader } from "./auth.mjs";

async function timeFirstRequest(site, path, cookies) {
	const restartStarted = performance.now();
	await site.stop();
	await site.start();
	const bootMs = performance.now() - restartStarted - site.lastStartWaitMs;
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

function medianSample(samples) {
	const sorted = samples.toSorted((a, b) => a.ttfbMs - b.ttfbMs);
	return { ...sorted[Math.floor(sorted.length / 2)], samplesTtfbMs: samples.map((s) => s.ttfbMs) };
}

/** Median of `samples` restarts for the first public page and the first admin API request. */
export async function measureColdStarts(site, cookies, samples = 3) {
	const publicPage = [];
	const adminApi = [];
	for (let i = 0; i < samples; i++) {
		publicPage.push(await timeFirstRequest(site, "/"));
		adminApi.push(await timeFirstRequest(site, "/_emdash/api/auth/me", cookies));
	}
	return { publicPage: medianSample(publicPage), adminApi: medianSample(adminApi) };
}
