import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { startGzipProxy } from "./gzip-proxy.mjs";

const read = (port, encoding) =>
	new Promise((resolve, reject) => {
		get(
			{
				host: "127.0.0.1",
				port,
				headers: { "accept-encoding": encoding, "x-perf-phase": "chosen-request" },
			},
			(response) => {
				const chunks = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ headers: response.headers, body: Buffer.concat(chunks) }),
				);
			},
		).on("error", reject);
	});

test("gzip changes wire bytes, preserves content and forwards audit headers; q=0 opts out", async () => {
	const body = "A real response body. ".repeat(1000);
	const server = createServer((request, response) => {
		assert.equal(request.headers["x-perf-phase"], "chosen-request");
		response.writeHead(200, {
			"content-type": "text/javascript",
			"content-length": Buffer.byteLength(body),
			etag: '"original"',
		});
		response.end(body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const proxy = await startGzipProxy(server.address().port);
	try {
		const compressed = await read(proxy.port, "gzip");
		assert.equal(compressed.headers["content-encoding"], "gzip");
		assert.equal(gunzipSync(compressed.body).toString(), body);
		assert.ok(compressed.body.length < Buffer.byteLength(body) / 2);
		assert.equal(compressed.headers.etag, 'W/"original"');
		const identity = await read(proxy.port, "gzip;q=0");
		assert.equal(identity.headers["content-encoding"], undefined);
		assert.equal(identity.body.toString(), body);
	} finally {
		await proxy.stop();
		await new Promise((resolve) => server.close(resolve));
	}
});
