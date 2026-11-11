/**
 * Response compression for the `@astrojs/node` standalone server.
 *
 * The adapter serves static files with `send` and writes rendered responses
 * straight to the socket, compressing neither. EmDash replaces the build's
 * server entry with one that wraps the adapter's request listener: assets
 * precompressed at build time are sent as they are, and every other response
 * with a compressible type is compressed as it streams.
 */

import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import type {
	IncomingMessage,
	OutgoingHttpHeader,
	OutgoingHttpHeaders,
	ServerResponse,
} from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export type ContentEncoding = "br" | "gzip";

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

/** Encodings in the order the server prefers them when the client rates them equally. */
const ENCODINGS: readonly ContentEncoding[] = ["br", "gzip"];

/** Responses smaller than this are sent uncompressed: the framing would cost more than it saves. */
const MIN_COMPRESS_BYTES = 1024;

const DYNAMIC_BROTLI_QUALITY = 4;
const DYNAMIC_GZIP_LEVEL = 6;

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const NO_TRANSFORM = /(?:^|,)\s*no-transform\s*(?:,|$)/i;
const QUERY_OR_HASH = /[?#]/;
const WEAK_PREFIX = /^W\//;

const COMPRESSIBLE_TYPES = new Set([
	"application/javascript",
	"application/ecmascript",
	"application/x-javascript",
	"application/json",
	"application/xml",
	"application/wasm",
	"application/vnd.ms-fontobject",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"font/ttf",
	"font/otf",
]);

/**
 * Pick the response encoding for an `Accept-Encoding` header, or `null` for
 * identity. The client's q-values decide; ties go to the server's order.
 */
export function negotiateEncoding(
	header: string | string[] | undefined,
	available: readonly ContentEncoding[] = ENCODINGS,
): ContentEncoding | null {
	if (!header) return null;
	const qualities = new Map<string, number>();
	for (const part of (Array.isArray(header) ? header.join(",") : header).split(",")) {
		const [rawName = "", ...params] = part.split(";");
		let name = rawName.trim().toLowerCase();
		if (!name) continue;
		if (name === "x-gzip") name = "gzip";
		let quality = 1;
		for (const param of params) {
			const [key = "", value = ""] = param.split("=");
			if (key.trim().toLowerCase() !== "q") continue;
			const parsed = Number(value.trim());
			quality = Number.isFinite(parsed) ? parsed : 0;
		}
		qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
	}
	const wildcard = qualities.get("*") ?? 0;
	let best: ContentEncoding | null = null;
	let bestQuality = 0;
	for (const encoding of ENCODINGS) {
		if (!available.includes(encoding)) continue;
		const quality = qualities.get(encoding) ?? wildcard;
		if (quality > bestQuality) {
			best = encoding;
			bestQuality = quality;
		}
	}
	return best;
}

/**
 * Whether a response of this type is worth compressing. Images, video, audio,
 * fonts in WOFF formats and archives are already compressed. Event streams are
 * left alone so each event reaches the client as soon as it is written.
 */
export function isCompressibleType(contentType: OutgoingHttpHeader | undefined): boolean {
	if (contentType === undefined) return false;
	const mime = String(contentType).split(";")[0]!.trim().toLowerCase();
	if (mime === "text/event-stream") return false;
	if (mime.startsWith("text/")) return true;
	if (mime.endsWith("+json") || mime.endsWith("+xml")) return true;
	return COMPRESSIBLE_TYPES.has(mime);
}

function headerString(value: OutgoingHttpHeader | undefined): string {
	if (value === undefined) return "";
	return Array.isArray(value) ? value.join(", ") : String(value);
}

function addVaryAcceptEncoding(res: ServerResponse): void {
	const fields = headerString(res.getHeader("Vary"))
		.split(",")
		.map((field) => field.trim())
		.filter(Boolean);
	if (fields.some((field) => field === "*" || field.toLowerCase() === "accept-encoding")) return;
	res.setHeader("Vary", [...fields, "Accept-Encoding"].join(", "));
}

function applyHeaders(
	res: ServerResponse,
	headers: OutgoingHttpHeaders | OutgoingHttpHeader[] | undefined,
): void {
	if (!headers) return;
	if (!Array.isArray(headers)) {
		for (const [name, value] of Object.entries(headers)) {
			if (value !== undefined) res.setHeader(name, value);
		}
		return;
	}
	const pairs: [string, OutgoingHttpHeader][] = [];
	if (headers.every((entry) => Array.isArray(entry))) {
		for (const [name, value] of headers) {
			if (name !== undefined && value !== undefined) pairs.push([String(name), value]);
		}
	} else {
		for (let i = 0; i + 1 < headers.length; i += 2) {
			pairs.push([String(headers[i]), headers[i + 1]!]);
		}
	}
	const grouped = new Map<string, string[]>();
	for (const [name, value] of pairs) {
		const values = grouped.get(name) ?? [];
		values.push(...(Array.isArray(value) ? value : [String(value)]));
		grouped.set(name, values);
	}
	for (const [name, values] of grouped) {
		res.setHeader(name, values.length === 1 ? values[0]! : values);
	}
}

/**
 * Decide from the final status and headers whether to compress, and adjust the
 * headers to match. Returns the chosen encoding, or `null` to send as is.
 */
function prepareEncoding(
	req: IncomingMessage,
	res: ServerResponse,
	statusCode: number,
): ContentEncoding | null {
	if (statusCode < 200 || statusCode === 204 || statusCode === 206 || statusCode === 304) {
		return null;
	}
	if (res.hasHeader("Content-Range")) return null;
	const existing = headerString(res.getHeader("Content-Encoding")).trim().toLowerCase();
	if (existing && existing !== "identity") return null;
	if (!isCompressibleType(res.getHeader("Content-Type"))) return null;
	addVaryAcceptEncoding(res);
	if (NO_TRANSFORM.test(headerString(res.getHeader("Cache-Control")))) {
		return null;
	}
	const length = Number(headerString(res.getHeader("Content-Length")) || Number.NaN);
	if (Number.isFinite(length) && length < MIN_COMPRESS_BYTES) return null;
	const encoding = negotiateEncoding(req.headers["accept-encoding"]);
	if (!encoding) return null;

	res.setHeader("Content-Encoding", encoding);
	res.removeHeader("Content-Length");
	res.removeHeader("Accept-Ranges");
	const etag = headerString(res.getHeader("ETag"));
	if (etag.startsWith('"')) res.setHeader("ETag", `W/${etag}`);
	return encoding;
}

function createEncoder(encoding: ContentEncoding): zlib.BrotliCompress | zlib.Gzip {
	if (encoding === "br") {
		return zlib.createBrotliCompress({
			flush: zlib.constants.BROTLI_OPERATION_FLUSH,
			params: { [zlib.constants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY },
		});
	}
	return zlib.createGzip({ level: DYNAMIC_GZIP_LEVEL, flush: zlib.constants.Z_SYNC_FLUSH });
}

type WriteCallback = (error?: Error | null) => void;

function byteLength(chunk: unknown, encoding: BufferEncoding | undefined): number | undefined {
	if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding);
	if (chunk instanceof Uint8Array) return chunk.byteLength;
	return undefined;
}

/**
 * Compress whatever is written to `res` when the request accepts it and the
 * response turns out to be compressible. The decision waits until the headers
 * are written, so it applies equally to files piped from disk and to rendered
 * responses. Each write is flushed through the encoder, which keeps streamed
 * HTML arriving progressively.
 */
export function compressResponse(req: IncomingMessage, res: ServerResponse): void {
	const originalWriteHead = res.writeHead;
	const originalWrite = res.write;
	const originalEnd = res.end;
	let encoder: zlib.BrotliCompress | zlib.Gzip | undefined;
	let ending = false;

	function startEncoder(encoding: ContentEncoding): void {
		const stream = createEncoder(encoding);
		encoder = stream;
		stream.on("data", (chunk: Buffer) => {
			if (!originalWrite.call(res, chunk)) stream.pause();
		});
		stream.on("end", () => {
			originalEnd.call(res);
		});
		stream.on("error", (error) => {
			res.destroy(error);
		});
		stream.on("drain", () => {
			res.emit("drain");
		});
		res.on("drain", () => {
			stream.resume();
		});
		res.on("close", () => {
			if (!stream.writableFinished) stream.destroy();
		});
	}

	const writeHead: ServerResponse["writeHead"] = function (
		statusCode: number,
		reasonOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
		maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[],
	) {
		if (res.headersSent) {
			return originalWriteHead.call(res, statusCode);
		}
		const reason = typeof reasonOrHeaders === "string" ? reasonOrHeaders : undefined;
		applyHeaders(res, typeof reasonOrHeaders === "string" ? maybeHeaders : reasonOrHeaders);
		const encoding = prepareEncoding(req, res, statusCode);
		if (encoding && req.method !== "HEAD") startEncoder(encoding);
		return reason === undefined
			? originalWriteHead.call(res, statusCode)
			: originalWriteHead.call(res, statusCode, reason);
	};
	res.writeHead = writeHead;

	const write = function (
		chunk: unknown,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		maybeCallback?: WriteCallback,
	): boolean {
		if (!res.headersSent) res.writeHead(res.statusCode);
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
		if (!encoder) {
			return encoding
				? originalWrite.call(res, chunk, encoding, callback)
				: originalWrite.call(res, chunk, callback);
		}
		if (ending) return false;
		return encoding ? encoder.write(chunk, encoding, callback) : encoder.write(chunk, callback);
	};
	res.write = write;

	const end = function (
		chunkOrCallback?: unknown,
		encodingOrCallback?: BufferEncoding | (() => void),
		maybeCallback?: () => void,
	): ServerResponse {
		const chunk = typeof chunkOrCallback === "function" ? undefined : chunkOrCallback;
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		const callback =
			typeof chunkOrCallback === "function"
				? () => Reflect.apply(chunkOrCallback, res, [])
				: typeof encodingOrCallback === "function"
					? encodingOrCallback
					: maybeCallback;
		if (!res.headersSent) {
			const length = chunk == null ? 0 : byteLength(chunk, encoding);
			if (
				length !== undefined &&
				!res.hasHeader("Content-Length") &&
				!res.hasHeader("Transfer-Encoding")
			) {
				res.setHeader("Content-Length", length);
			}
			res.writeHead(res.statusCode);
		}
		if (!encoder) {
			if (chunk == null) return originalEnd.call(res, callback);
			return encoding
				? originalEnd.call(res, chunk, encoding, callback)
				: originalEnd.call(res, chunk, callback);
		}
		if (ending) return res;
		ending = true;
		if (callback) res.once("finish", callback);
		if (chunk == null) encoder.end();
		else if (encoding) encoder.end(chunk, encoding);
		else encoder.end(chunk);
		return res;
	};
	res.end = end;
}

/** A file under the client directory with precompressed copies beside it. */
export interface PrecompressedFile {
	/** The `Content-Type` the file is served with. */
	type: string;
	/** The encodings that have a copy on disk, as `<file>.br` and `<file>.gz`. */
	encodings: ContentEncoding[];
}

/** The build's record of precompressed assets, keyed by path relative to the client directory. */
export interface PrecompressedManifest {
	files: Record<string, PrecompressedFile>;
}

export interface PrecompressedAssets {
	clientDir: string;
	/** Astro's `base`, always ending with `/`. */
	base: string;
	files: Map<string, PrecompressedFile>;
}

const ENCODED_EXTENSION: Record<ContentEncoding, string> = { br: ".br", gzip: ".gz" };

function isEncoding(value: unknown): value is ContentEncoding {
	return value === "br" || value === "gzip";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse a manifest written by `precompressAssets()`. Malformed entries are dropped. */
export function parsePrecompressedManifest(json: string): Map<string, PrecompressedFile> {
	const files = new Map<string, PrecompressedFile>();
	const parsed: unknown = JSON.parse(json);
	if (!isRecord(parsed) || !isRecord(parsed.files)) return files;
	for (const [path, entry] of Object.entries(parsed.files)) {
		if (!isRecord(entry) || typeof entry.type !== "string" || !Array.isArray(entry.encodings)) {
			continue;
		}
		const encodings = entry.encodings.filter(isEncoding);
		if (encodings.length > 0) files.set(path, { type: entry.type, encodings });
	}
	return files;
}

function requestedAssetPath(url: string | undefined, base: string): string | undefined {
	if (!url) return undefined;
	const pathname = url.split(QUERY_OR_HASH, 1)[0]!;
	let decoded: string;
	try {
		decoded = decodeURI(pathname);
	} catch {
		return undefined;
	}
	return decoded.startsWith(base) ? decoded.slice(base.length) : undefined;
}

function etagMatches(header: string | undefined, etag: string): boolean {
	if (!header) return false;
	const opaque = etag.replace(WEAK_PREFIX, "");
	return header
		.split(",")
		.map((tag) => tag.trim())
		.some((tag) => tag === "*" || tag.replace(WEAK_PREFIX, "") === opaque);
}

async function sendPrecompressed(
	req: IncomingMessage,
	res: ServerResponse,
	file: string,
	type: string,
	encoding: ContentEncoding,
	fallback: () => void,
): Promise<void> {
	let size: number;
	let mtime: Date;
	try {
		const stats = await stat(file);
		if (!stats.isFile()) throw new Error("not a file");
		size = stats.size;
		mtime = stats.mtime;
	} catch {
		fallback();
		return;
	}
	const etag = `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
	res.setHeader("Content-Type", type);
	res.setHeader("Content-Encoding", encoding);
	res.setHeader("Cache-Control", IMMUTABLE_CACHE_CONTROL);
	res.setHeader("ETag", etag);
	res.setHeader("Last-Modified", mtime.toUTCString());
	if (etagMatches(req.headers["if-none-match"], etag)) {
		res.removeHeader("Content-Encoding");
		res.removeHeader("Content-Type");
		res.writeHead(304);
		res.end();
		return;
	}
	res.setHeader("Content-Length", size);
	if (req.method === "HEAD") {
		res.writeHead(200);
		res.end();
		return;
	}
	const stream = createReadStream(file);
	stream.on("error", (error) => {
		res.destroy(error);
	});
	res.on("close", () => {
		stream.destroy();
	});
	res.writeHead(200);
	stream.pipe(res);
}

/**
 * Serve a precompressed copy of a build asset when the request accepts one.
 * Returns `false` to let the next handler serve the request.
 */
function servePrecompressed(
	req: IncomingMessage,
	res: ServerResponse,
	assets: PrecompressedAssets,
	fallback: () => void,
): boolean {
	if (req.method !== "GET" && req.method !== "HEAD") return false;
	const path = requestedAssetPath(req.url, assets.base);
	if (path === undefined) return false;
	const entry = assets.files.get(path);
	if (!entry) return false;
	addVaryAcceptEncoding(res);
	if (req.headers.range) return false;
	const encoding = negotiateEncoding(req.headers["accept-encoding"], entry.encodings);
	if (!encoding) return false;
	void sendPrecompressed(
		req,
		res,
		join(assets.clientDir, path) + ENCODED_EXTENSION[encoding],
		entry.type,
		encoding,
		fallback,
	);
	return true;
}

/** Wrap a Node request listener so its responses are compressed. */
export function withCompression(listener: Listener, assets?: PrecompressedAssets): Listener {
	return (req, res) => {
		const next = () => {
			compressResponse(req, res);
			listener(req, res);
		};
		if (assets && servePrecompressed(req, res, assets, next)) return;
		next();
	};
}

/** Load the build's precompressed-asset manifest, or `undefined` when it is missing or unreadable. */
export function loadPrecompressedAssets(
	manifest: URL,
	clientDir: URL,
	base: string,
): PrecompressedAssets | undefined {
	let files: Map<string, PrecompressedFile>;
	try {
		files = parsePrecompressedManifest(readFileSync(manifest, "utf8"));
	} catch {
		return undefined;
	}
	return {
		clientDir: fileURLToPath(clientDir),
		base: base.endsWith("/") ? base : `${base}/`,
		files,
	};
}

interface StartedServer {
	server?: {
		server?: {
			listeners(event: "request"): Function[];
			removeAllListeners(event: "request"): unknown;
			on(event: "request", listener: Listener): unknown;
		};
	};
}

/** The exports of `@astrojs/node/server.js` that the wrapper uses. */
export interface NodeAdapterServer {
	handler: Listener;
	options: { mode: string };
	startServer: () => StartedServer;
}

export interface NodeStandaloneConfig {
	/** `ASTRO_NODE_AUTOSTART` as it was before the entry disabled the adapter's own autostart. */
	autostart: string | undefined;
	manifest: URL;
	clientDir: URL;
	base: string;
}

/**
 * Build the server entry's `handler` and `startServer` exports from the
 * adapter's, adding compression in standalone mode, and start the server
 * unless `ASTRO_NODE_AUTOSTART` was `disabled`.
 */
export function wrapNodeStandalone(
	adapter: NodeAdapterServer,
	config: NodeStandaloneConfig,
): Pick<NodeAdapterServer, "handler" | "startServer"> {
	if (config.autostart === undefined) delete process.env.ASTRO_NODE_AUTOSTART;
	else process.env.ASTRO_NODE_AUTOSTART = config.autostart;

	if (adapter.options.mode !== "standalone") {
		return { handler: adapter.handler, startServer: adapter.startServer };
	}

	const assets = loadPrecompressedAssets(config.manifest, config.clientDir, config.base);
	const startServer = () => {
		const started = adapter.startServer();
		const server = started.server?.server;
		if (server) {
			const listeners = server.listeners("request");
			server.removeAllListeners("request");
			server.on(
				"request",
				withCompression((req, res) => {
					for (const listener of listeners) Reflect.apply(listener, server, [req, res]);
				}, assets),
			);
		}
		return started;
	};
	if (config.autostart !== "disabled") startServer();
	return { handler: withCompression(adapter.handler, assets), startServer };
}
