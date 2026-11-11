import { createReadStream, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
	negotiateEncoding,
	withCompression,
	wrapNodeStandalone,
	type PrecompressedAssets,
} from "../../../src/astro/node/compression.js";
import { precompressAssets } from "../../../src/astro/node/precompress.js";

type Listener = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface Reply {
	status: number;
	headers: http.IncomingHttpHeaders;
	raw: Buffer;
	body: string;
}

const servers: http.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
	);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function listen(listener: Listener): Promise<string> {
	const server = http.createServer(listener);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function decode(raw: Buffer, encoding: string | undefined): Buffer {
	if (raw.length === 0) return raw;
	if (encoding === "br") return zlib.brotliDecompressSync(raw);
	if (encoding === "gzip") return zlib.gunzipSync(raw);
	return raw;
}

function request(
	origin: string,
	path: string,
	headers: http.OutgoingHttpHeaders = {},
	method = "GET",
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.request(`${origin}${path}`, { method, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks);
				const encoding = res.headers["content-encoding"];
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					raw,
					body: decode(raw, encoding).toString("utf8"),
				});
			});
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

const HTML = `<!doctype html><html><body>${"<p>EmDash admin</p>".repeat(400)}</body></html>`;

/** Writes a response the way Astro's `writeResponse` does. */
const astroLike =
	(contentType: string, body: string | Buffer, extra: http.OutgoingHttpHeaders = {}): Listener =>
	(_req, res) => {
		res.writeHead(200, { "Content-Type": contentType, ...extra });
		const bytes = Buffer.from(body);
		const middle = Math.floor(bytes.length / 2);
		res.write(bytes.subarray(0, middle));
		res.write(bytes.subarray(middle));
		res.end();
	};

describe("negotiateEncoding", () => {
	it.each([
		["gzip, deflate, br, zstd", "br"],
		["gzip, deflate", "gzip"],
		["x-gzip", "gzip"],
		["br;q=0.5, gzip", "gzip"],
		["br;q=0, gzip;q=0.1", "gzip"],
		["*", "br"],
		["*;q=0.2, br;q=0", "gzip"],
		["identity", null],
		["deflate", null],
		["", null],
		[undefined, null],
	])("%j selects %j", (header, expected) => {
		expect(negotiateEncoding(header)).toBe(expected);
	});

	it("only offers the encodings available", () => {
		expect(negotiateEncoding("br, gzip", ["gzip"])).toBe("gzip");
		expect(negotiateEncoding("br", ["gzip"])).toBeNull();
	});
});

describe("withCompression", () => {
	it.each([
		["gzip, deflate, br", "br"],
		["gzip, deflate", "gzip"],
	])("compresses an HTML page for Accept-Encoding %j", async (acceptEncoding, encoding) => {
		const origin = await listen(withCompression(astroLike("text/html; charset=utf-8", HTML)));
		const reply = await request(origin, "/", { "accept-encoding": acceptEncoding });

		expect(reply.headers["content-encoding"]).toBe(encoding);
		expect(reply.headers.vary).toBe("Accept-Encoding");
		expect(reply.headers["content-length"]).toBeUndefined();
		expect(reply.raw.length).toBeLessThan(HTML.length / 10);
		expect(reply.body).toBe(HTML);
	});

	it("sends identity, still varying on Accept-Encoding, when the client accepts no encoding", async () => {
		const origin = await listen(withCompression(astroLike("text/html; charset=utf-8", HTML)));
		const reply = await request(origin, "/");

		expect(reply.headers["content-encoding"]).toBeUndefined();
		expect(reply.headers.vary).toBe("Accept-Encoding");
		expect(reply.body).toBe(HTML);
	});

	it("compresses JSON sent in one end() call and keeps the existing Vary", async () => {
		const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, id) => ({ id })) });
		const origin = await listen(
			withCompression((_req, res) => {
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Vary", "Cookie");
				res.end(json);
			}),
		);
		const reply = await request(origin, "/_emdash/api/content/posts", { "accept-encoding": "br" });

		expect(reply.headers["content-encoding"]).toBe("br");
		expect(reply.headers.vary).toBe("Cookie, Accept-Encoding");
		expect(JSON.parse(reply.body)).toEqual(JSON.parse(json));
	});

	it("leaves images uncompressed and does not vary them", async () => {
		const png = Buffer.alloc(50_000, 7);
		const origin = await listen(
			withCompression((_req, res) => {
				res.setHeader("Content-Type", "image/png");
				res.setHeader("Content-Length", png.length);
				res.end(png);
			}),
		);
		const reply = await request(origin, "/photo.png", { "accept-encoding": "gzip, br" });

		expect(reply.headers["content-encoding"]).toBeUndefined();
		expect(reply.headers.vary).toBeUndefined();
		expect(reply.headers["content-length"]).toBe(String(png.length));
		expect(reply.raw.equals(png)).toBe(true);
	});

	it("does not compress a response that is already encoded", async () => {
		const gzipped = zlib.gzipSync(HTML);
		const origin = await listen(
			withCompression(astroLike("text/html", gzipped, { "Content-Encoding": "gzip" })),
		);
		const reply = await request(origin, "/", { "accept-encoding": "br, gzip" });

		expect(reply.headers["content-encoding"]).toBe("gzip");
		expect(reply.body).toBe(HTML);
	});

	it("does not compress small responses, event streams or no-transform responses", async () => {
		const routes: Record<string, Listener> = {
			"/small": (_req, res) => {
				res.setHeader("Content-Type", "text/plain");
				res.end("ok");
			},
			"/events": astroLike("text/event-stream", "data: x\n\n".repeat(500)),
			"/no-transform": astroLike("text/html", HTML, { "Cache-Control": "private, no-transform" }),
		};
		const origin = await listen(withCompression((req, res) => routes[req.url ?? ""]!(req, res)));

		for (const path of Object.keys(routes)) {
			const reply = await request(origin, path, { "accept-encoding": "br, gzip" });
			expect(reply.headers["content-encoding"], path).toBeUndefined();
		}
	});

	it("leaves partial content and HEAD bodies alone", async () => {
		const origin = await listen(
			withCompression((req, res) => {
				if (req.headers.range) {
					res.writeHead(206, {
						"Content-Type": "text/plain",
						"Content-Range": "bytes 0-1999/4000",
					});
					res.end("a".repeat(2000));
					return;
				}
				astroLike("text/html", HTML)(req, res);
			}),
		);

		const partial = await request(origin, "/", { "accept-encoding": "br", range: "bytes=0-1999" });
		expect(partial.status).toBe(206);
		expect(partial.headers["content-encoding"]).toBeUndefined();
		expect(partial.raw.length).toBe(2000);

		const head = await request(origin, "/", { "accept-encoding": "br" }, "HEAD");
		expect(head.headers["content-encoding"]).toBe("br");
		expect(head.raw.length).toBe(0);
	});

	it("compresses a large file piped from disk and weakens its ETag", async () => {
		const dir = mkdtempSync(join(tmpdir(), "emdash-compress-"));
		dirs.push(dir);
		const file = join(dir, "lib.js");
		const source = Array.from({ length: 60_000 }, (_, i) => `export const v${i} = ${i};\n`).join(
			"",
		);
		writeFileSync(file, source);
		const origin = await listen(
			withCompression((_req, res) => {
				res.setHeader("Content-Type", "text/javascript; charset=utf-8");
				res.setHeader("Content-Length", Buffer.byteLength(source));
				res.setHeader("Accept-Ranges", "bytes");
				res.setHeader("ETag", '"abc"');
				createReadStream(file).pipe(res);
			}),
		);
		const reply = await request(origin, "/_astro/lib.js", { "accept-encoding": "gzip" });

		expect(reply.headers["content-encoding"]).toBe("gzip");
		expect(reply.headers["accept-ranges"]).toBeUndefined();
		expect(reply.headers.etag).toBe('W/"abc"');
		expect(reply.body).toBe(source);
	});

	it("delivers each streamed chunk before the response ends", async () => {
		let finish: () => void = () => {};
		const origin = await listen(
			withCompression((_req, res) => {
				res.writeHead(200, { "Content-Type": "text/html" });
				res.write(`<head>${"x".repeat(2000)}</head>`);
				finish = () => res.end("<body>done</body>");
			}),
		);

		const firstChunk = await new Promise<string>((resolve, reject) => {
			http
				.get(`${origin}/`, { headers: { "accept-encoding": "gzip" } }, (res) => {
					const gunzip = zlib.createGunzip();
					res.pipe(gunzip);
					gunzip.once("data", (chunk: Buffer) => {
						resolve(chunk.toString("utf8"));
						finish();
					});
				})
				.on("error", reject);
		});

		expect(firstChunk.startsWith("<head>")).toBe(true);
	});
});

describe("precompressed assets", () => {
	const SCRIPT = `console.log(${JSON.stringify("EmDash ".repeat(2000))});\n`;

	async function buildAssets(base = "/"): Promise<PrecompressedAssets> {
		const clientDir = mkdtempSync(join(tmpdir(), "emdash-precompress-"));
		dirs.push(clientDir);
		mkdirSync(join(clientDir, "_astro"));
		writeFileSync(join(clientDir, "_astro", "app.js"), SCRIPT);
		const manifest = await precompressAssets(clientDir, "_astro");
		return { clientDir, base, files: new Map(Object.entries(manifest.files)) };
	}

	const identity: Listener = (_req, res) => {
		res.setHeader("Content-Type", "text/javascript; charset=utf-8");
		res.setHeader("Content-Length", Buffer.byteLength(SCRIPT));
		res.end(SCRIPT);
	};

	it.each([
		["br, gzip", "br", ".br"],
		["gzip", "gzip", ".gz"],
	])("sends the stored copy for %j", async (acceptEncoding, encoding, extension) => {
		const assets = await buildAssets();
		const stored = await readFile(join(assets.clientDir, "_astro", `app.js${extension}`));
		const origin = await listen(withCompression(identity, assets));
		const reply = await request(origin, "/_astro/app.js", { "accept-encoding": acceptEncoding });

		expect(reply.headers["content-encoding"]).toBe(encoding);
		expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
		expect(reply.headers["content-length"]).toBe(String(stored.length));
		expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
		expect(reply.headers.vary).toBe("Accept-Encoding");
		expect(reply.raw.equals(stored)).toBe(true);
		expect(reply.body).toBe(SCRIPT);
	});

	it("falls back to the next handler for identity and range requests", async () => {
		const assets = await buildAssets();
		const origin = await listen(withCompression(identity, assets));

		const plain = await request(origin, "/_astro/app.js");
		expect(plain.headers["content-encoding"]).toBeUndefined();
		expect(plain.headers.vary).toBe("Accept-Encoding");
		expect(plain.body).toBe(SCRIPT);

		const ranged = await request(origin, "/_astro/app.js", {
			"accept-encoding": "br",
			range: "bytes=0-10",
		});
		expect(ranged.headers["content-encoding"]).toBe("br");
		expect(ranged.headers["cache-control"]).toBeUndefined();
	});

	it("answers a matching If-None-Match with 304", async () => {
		const assets = await buildAssets();
		const origin = await listen(withCompression(identity, assets));
		const first = await request(origin, "/_astro/app.js", { "accept-encoding": "br" });
		const second = await request(origin, "/_astro/app.js", {
			"accept-encoding": "br",
			"if-none-match": first.headers.etag,
		});

		expect(second.status).toBe(304);
		expect(second.raw.length).toBe(0);
	});

	it("resolves asset paths under Astro's base", async () => {
		const assets = await buildAssets("/blog/");
		const origin = await listen(withCompression(identity, assets));
		const reply = await request(origin, "/blog/_astro/app.js", { "accept-encoding": "br" });

		expect(reply.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
		expect(reply.body).toBe(SCRIPT);
	});

	it("stores copies only of compressible files worth compressing", async () => {
		const clientDir = mkdtempSync(join(tmpdir(), "emdash-precompress-"));
		dirs.push(clientDir);
		mkdirSync(join(clientDir, "_astro", "nested"), { recursive: true });
		writeFileSync(join(clientDir, "_astro", "nested", "page.css"), "a{color:red}".repeat(500));
		writeFileSync(join(clientDir, "_astro", "tiny.js"), "1");
		writeFileSync(join(clientDir, "_astro", "photo.png"), Buffer.alloc(5000, 1));
		writeFileSync(join(clientDir, "_astro", "font.woff2"), Buffer.alloc(5000, 1));
		writeFileSync(join(clientDir, "public.js"), SCRIPT);

		const manifest = await precompressAssets(clientDir, "_astro");

		expect(manifest.files).toEqual({
			"_astro/nested/page.css": { type: "text/css; charset=utf-8", encodings: ["br", "gzip"] },
		});
		const stored = await readFile(join(clientDir, "_astro", "nested", "page.css.br"));
		expect(zlib.brotliDecompressSync(stored).toString()).toBe("a{color:red}".repeat(500));
	});
});

describe("wrapNodeStandalone", () => {
	const manifest = pathToFileURL(join(tmpdir(), "emdash-missing-manifest.json"));
	const clientDir = pathToFileURL(`${tmpdir()}/`);

	function fakeAdapter(mode: string) {
		const started: http.Server[] = [];
		const listener = astroLike("text/html", HTML);
		return {
			started,
			adapter: {
				handler: listener,
				options: { mode },
				startServer: () => {
					const server = http.createServer(listener);
					servers.push(server);
					started.push(server);
					return { server: { server } };
				},
			},
		};
	}

	afterEach(() => {
		delete process.env.ASTRO_NODE_AUTOSTART;
	});

	it("starts a compressing server and restores ASTRO_NODE_AUTOSTART", async () => {
		const { adapter, started } = fakeAdapter("standalone");
		process.env.ASTRO_NODE_AUTOSTART = "disabled";

		wrapNodeStandalone(adapter, { autostart: undefined, manifest, clientDir, base: "/" });

		expect(process.env.ASTRO_NODE_AUTOSTART).toBeUndefined();
		expect(started).toHaveLength(1);
		const server = started[0]!;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const reply = await request(origin, "/", { "accept-encoding": "br" });
		expect(reply.headers["content-encoding"]).toBe("br");
		expect(reply.body).toBe(HTML);
	});

	it("does not start when autostart was disabled, but still compresses the handler", async () => {
		const { adapter, started } = fakeAdapter("standalone");

		const wrapped = wrapNodeStandalone(adapter, {
			autostart: "disabled",
			manifest,
			clientDir,
			base: "/",
		});

		expect(process.env.ASTRO_NODE_AUTOSTART).toBe("disabled");
		expect(started).toHaveLength(0);
		const reply = await request(await listen(wrapped.handler), "/", { "accept-encoding": "gzip" });
		expect(reply.headers["content-encoding"]).toBe("gzip");
	});

	it("passes the adapter through in middleware mode", () => {
		const { adapter, started } = fakeAdapter("middleware");

		const wrapped = wrapNodeStandalone(adapter, {
			autostart: undefined,
			manifest,
			clientDir,
			base: "/",
		});

		expect(started).toHaveLength(0);
		expect(wrapped.handler).toBe(adapter.handler);
	});
});
