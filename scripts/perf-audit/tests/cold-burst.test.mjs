import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { burstPlan, measureColdBursts, MIN_BURST_REQUESTS } from "../lib/cold-burst.mjs";
import { coldBurstFailures, failedResponses } from "../lib/evaluate.mjs";

const SESSION_COOKIE = /astro-session=s/;

void test("each burst sends at least the minimum signed-out and admin API requests", () => {
	const [signedOut, mixed] = burstPlan({
		publicPaths: ["/", "/posts/a", "/category/b"],
		collection: "posts",
	});
	assert.ok(signedOut.requests.length >= MIN_BURST_REQUESTS);
	assert.ok(signedOut.requests.every((r) => !r.signedIn));
	assert.ok(mixed.requests.filter((r) => !r.signedIn).length >= MIN_BURST_REQUESTS);
	assert.ok(mixed.requests.filter((r) => r.signedIn).length >= MIN_BURST_REQUESTS);
	assert.ok(mixed.requests.some((r) => r.path === "/_emdash/api/content/posts?limit=20"));
});

/** A site whose server answers from `handler` and counts restarts. */
async function fakeSite(handler) {
	const siteDir = mkdtempSync(join(tmpdir(), "cold-burst-"));
	mkdirSync(join(siteDir, "dist/client/_astro"), { recursive: true });
	writeFileSync(join(siteDir, "dist/client/_headers"), "");
	writeFileSync(join(siteDir, "dist/client/_astro/app.css"), "");
	const seen = [];
	const server = createServer((req, res) => {
		seen.push({ url: req.url, cookie: req.headers.cookie ?? null });
		if (req.url === "/_astro/app.css") {
			res.end("");
			return;
		}
		handler(req, res);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const site = {
		siteDir,
		origin: `http://127.0.0.1:${server.address().port}`,
		restarts: 0,
		async stop() {},
		async start() {
			site.restarts++;
		},
	};
	const close = () => {
		server.close();
		rmSync(siteDir, { recursive: true, force: true });
	};
	return { site, seen, close };
}

void test("a burst fails on every response that is not 2xx or 3xx and keeps its body", async () => {
	const { site, seen, close } = await fakeSite((req, res) => {
		if (req.url === "/broken") {
			res.statusCode = 500;
			res.end("The Workers runtime canceled this request");
			return;
		}
		res.statusCode = req.url === "/moved" ? 302 : 200;
		res.end("ok");
	});
	try {
		const plan = [
			{
				name: "burst",
				requests: [
					{ path: "/", signedIn: false },
					{ path: "/moved", signedIn: false },
					{ path: "/broken", signedIn: true },
				],
			},
		];
		const result = await measureColdBursts(site, {
			plan,
			cookies: [{ name: "astro-session", value: "s" }],
			rounds: 2,
		});
		assert.equal(site.restarts, 2);
		assert.equal(result.requests, 6);
		assert.equal(result.failedRequests, 2);
		assert.deepEqual(
			result.bursts[0].failed.map((f) => [f.path, f.status, f.body]),
			[["/broken", 500, "The Workers runtime canceled this request"]],
		);
		assert.ok(seen.every((r) => r.url !== "/_headers"));
		const broken = seen.find((r) => r.url === "/broken");
		assert.match(broken.cookie, SESSION_COOKIE);
		assert.equal(seen.find((r) => r.url === "/").cookie, null);

		const failures = coldBurstFailures([{ profile: "p", coldBurst: result }]);
		assert.equal(failures.length, 1);
		assert.equal(failures[0].failed, 2);
		assert.equal(failures[0].example.path, "/broken");
	} finally {
		close();
	}
});

void test("a request the server never answers fails the burst", async () => {
	const { site, close } = await fakeSite((req) => {
		req.socket.destroy();
	});
	try {
		const result = await measureColdBursts(site, {
			plan: [{ name: "burst", requests: [{ path: "/", signedIn: false }] }],
			cookies: null,
			rounds: 1,
		});
		assert.equal(result.failedRequests, 1);
		assert.equal(result.bursts[0].failed[0].status, 0);
	} finally {
		close();
	}
});

void test("failed responses collect same-origin server errors from every measurement", () => {
	const origin = "http://127.0.0.1:4000";
	const failures = failedResponses(
		{
			pages: [
				{
					name: "public home",
					viewport: "desktop",
					waterfall: [
						{ url: `${origin}/`, status: 500 },
						{ url: `${origin}/missing.png`, status: 404 },
						{ url: "https://elsewhere.example/x", status: 503 },
						{ url: `${origin}/`, status: 500 },
					],
					serverPass: [{ path: "/", status: 200 }],
				},
			],
			coldStart: {
				publicPage: { path: "/", status: 500 },
				adminApi: { path: "/_emdash/api/auth/me", status: 200 },
			},
		},
		origin,
	);
	assert.deepEqual(failures, [
		{ where: "desktop public home", path: "/", status: 500, count: 2 },
		{ where: "cold start", path: "/", status: 500, count: 1 },
	]);
});
