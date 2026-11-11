/**
 * Build-time compression of the client assets a Node standalone server sends.
 *
 * Fingerprinted assets never change after the build, so they are compressed
 * once, at a higher level than a server could afford per request, and the
 * server sends the stored copy.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import type { ContentEncoding, PrecompressedFile, PrecompressedManifest } from "./compression.js";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/**
 * On the admin bundle, brotli 7 comes within 2% of brotli 9 in a fifth of the
 * time. Brotli 11 saves another 10% but takes ten times as long.
 */
const BROTLI_QUALITY = 7;
const GZIP_LEVEL = 9;
const MIN_BYTES = 1024;

/** Types match what the adapter's static server sends for the same file. */
const PRECOMPRESSED_TYPES: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml",
	".wasm": "application/wasm",
	".ttf": "font/ttf",
	".otf": "font/otf",
};

async function encode(encoding: ContentEncoding, source: Buffer): Promise<Buffer> {
	if (encoding === "br") {
		return brotliCompress(source, {
			params: {
				[zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
				[zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length,
			},
		});
	}
	return gzip(source, { level: GZIP_LEVEL });
}

const ENCODED_EXTENSION: Record<ContentEncoding, string> = { br: ".br", gzip: ".gz" };

/**
 * Write `.br` and `.gz` copies of the compressible files in `assetsDir`,
 * keeping a copy only when it is smaller than the original. Returns the
 * manifest the server reads, keyed by path relative to `clientDir`.
 */
export async function precompressAssets(
	clientDir: string,
	assetsDir: string,
): Promise<PrecompressedManifest> {
	const root = join(clientDir, assetsDir);
	let entries;
	try {
		entries = await readdir(root, { recursive: true, withFileTypes: true });
	} catch {
		return { files: {} };
	}

	const files: Record<string, PrecompressedFile> = {};
	await Promise.all(
		entries.map(async (entry) => {
			if (!entry.isFile()) return;
			const type = PRECOMPRESSED_TYPES[extname(entry.name).toLowerCase()];
			if (!type) return;
			const path = join(entry.parentPath, entry.name);
			if ((await stat(path)).size < MIN_BYTES) return;
			const source = await readFile(path);
			const written = await Promise.all(
				(["br", "gzip"] as const).map(async (encoding) => {
					const encoded = await encode(encoding, source);
					if (encoded.length >= source.length) return undefined;
					await writeFile(path + ENCODED_EXTENSION[encoding], encoded);
					return encoding;
				}),
			);
			const encodings = written.filter((encoding) => encoding !== undefined);
			if (encodings.length > 0) {
				files[relative(clientDir, path).split(sep).join("/")] = { type, encodings };
			}
		}),
	);
	return { files };
}
