/**
 * Serve uploaded media files
 *
 * GET /_emdash/api/media/file/:key - Serve file from storage, or a byte range of it
 */

import type { APIRoute } from "astro";

import { apiError, handleError } from "#api/error.js";
import { MediaRepository } from "#db/repositories/media.js";
import { contentDisposition } from "#media/content-disposition.js";
import {
	IMMUTABLE_IMAGE_CACHE,
	MEDIA_VERSION_PARAM,
	MUTABLE_MEDIA_CACHE_CONTROL,
	isNotModified,
	resolveOriginalBody,
	validatorHeaders,
} from "#media/image-endpoint.js";

import { parseRangeHeader, resolveByteRange } from "../../../../../storage/range.js";
import type { Storage, StoredFileInfo } from "../../../../../storage/types.js";
import { isRefusedStorageKey } from "../../../../../transfer/staging/keys.js";

export const prerender = false;

const MAX_KEY_DECODES = 3;
/** What a response header can carry: no line breaks or control characters, and nothing past Latin-1. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;

/**
 * Whether a key is, or percent-decodes to, a key this route must refuse.
 * Every decoding layer is checked because storage backends differ in whether
 * they decode keys; a key that is still encoded after the last layer, or
 * does not decode, is refused.
 */
function isPrivateMediaKey(key: string): boolean {
	let candidate = key;
	for (let layer = 0; layer <= MAX_KEY_DECODES; layer++) {
		if (isRefusedStorageKey(candidate)) return true;
		let decoded: string;
		try {
			decoded = decodeURIComponent(candidate);
		} catch {
			return true;
		}
		if (decoded === candidate) return false;
		candidate = decoded;
	}
	return true;
}

/**
 * Content types that are safe to display inline (simple raster/vector images, video, audio).
 * Everything else gets Content-Disposition: attachment to prevent script execution.
 */
const SAFE_INLINE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/x-icon",
	"video/mp4",
	"video/webm",
	"audio/mpeg",
	"audio/wav",
	"audio/ogg",
]);

/**
 * What an adapter says about the file at `key`: null for no file, undefined when it can't say.
 * A custom adapter's answer is checked, and one that doesn't fit is ignored.
 */
async function describeStoredFile(
	storage: Storage,
	key: string,
): Promise<StoredFileInfo | null | undefined> {
	// Everything a custom adapter hands back is read in here, getters included.
	try {
		if (typeof storage.describeStoredFile !== "function") return undefined;
		const details: unknown = await storage.describeStoredFile(key);
		if (details === null) return null;
		if (typeof details !== "object") return undefined;
		const contentType = "contentType" in details ? details.contentType : undefined;
		const size = "size" in details ? details.size : undefined;
		const lastModified = "lastModified" in details ? details.lastModified : undefined;
		if (typeof contentType !== "string" || !HEADER_VALUE.test(contentType)) return undefined;
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
		if (lastModified === undefined) return { contentType, size };
		if (!(lastModified instanceof Date) || Number.isNaN(lastModified.getTime())) return undefined;
		return { contentType, size, lastModified };
	} catch {
		return undefined;
	}
}

export const GET: APIRoute = async ({ params, locals, request, cache }) => {
	const { key } = params;
	const { emdash } = locals;

	if (!key) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	// Backup archives and transfer staging share the storage bucket but hold
	// whole-site content; they must never be reachable through this public,
	// unauthenticated route.
	if (isPrivateMediaKey(key)) {
		return apiError("NOT_FOUND", "File not found", 404);
	}

	if (!emdash?.storage) {
		return apiError("NOT_CONFIGURED", "Storage not configured", 500);
	}

	// An unread download retains its storage connection even for a bodyless response.
	let unusedBody: ReadableStream<Uint8Array> | undefined;
	const version = new URL(request.url).searchParams.get(MEDIA_VERSION_PARAM);
	try {
		// A HEAD answered from the file's details reads none of it.
		const details =
			request.method === "HEAD" ? await describeStoredFile(emdash.storage, key) : undefined;
		if (details === null) return apiError("NOT_FOUND", "File not found", 404);
		// Range requests that include If-Range are served as whole-file responses
		// because this route does not compare If-Range validators.
		const range =
			details || request.headers.has("If-Range")
				? null
				: parseRangeHeader(request.headers.get("Range"));
		// The route cache keys entries by URL alone, so a cached partial
		// response would be served to requests for the whole file.
		if (range && cache?.enabled) cache.set(false);
		const result = details
			? { ...details, body: undefined, range: undefined }
			: range
				? await emdash.storage.download(key, { range })
				: await emdash.storage.download(key);
		unusedBody = result.body;
		const served = range ? result.range : undefined;

		// Adapters return the whole file for a range they don't serve, including
		// one past the end. A size of 0 may be unknown, so it rules nothing out.
		if (range && !served && result.size > 0 && !resolveByteRange(range, result.size)) {
			const response = apiError("RANGE_NOT_SATISFIABLE", "Range not satisfiable", 416);
			response.headers.set("Content-Range", `bytes */${result.size}`);
			return response;
		}

		const isImage = result.contentType.startsWith("image/");

		if (isNotModified(request, result.size, result.lastModified)) {
			return new Response(null, {
				status: 304,
				headers: {
					"Content-Type": result.contentType,
					"Cache-Control": isImage ? MUTABLE_MEDIA_CACHE_CONTROL : IMMUTABLE_IMAGE_CACHE,
					...validatorHeaders(result.size, result.lastModified),
				},
			});
		}

		let content: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | undefined = result.body;
		let cacheControl = IMMUTABLE_IMAGE_CACHE;
		// A HEAD response sends no bytes, so it isn't worth reading them to verify the version.
		if (isImage && (served || request.method === "HEAD" || !result.body)) {
			cacheControl = MUTABLE_MEDIA_CACHE_CONTROL;
		} else if (isImage) {
			const original = await resolveOriginalBody(version, result.body, result.size);
			content = original.body;
			cacheControl = original.cacheControl;
		}

		const headers: Record<string, string> = {
			"Content-Type": result.contentType,
			"Cache-Control": cacheControl,
			"Accept-Ranges": "bytes",
			"X-Content-Type-Options": "nosniff",
			// Sandbox CSP on all user-uploaded content — prevents script execution
			// even for SVGs navigated to directly or content types that support scripting.
			"Content-Security-Policy":
				"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
			...validatorHeaders(result.size, result.lastModified),
		};

		// Safe image/media types can render inline; everything else (SVG, PDF,
		// HTML, JS, etc.) must be downloaded to prevent stored XSS.
		const disposition = SAFE_INLINE_TYPES.has(result.contentType) ? "inline" : "attachment";

		// Name the download after the uploaded filename. Without this the
		// browser falls back to the last path segment of the URL -- the storage
		// key -- and every downloaded document is named after its ULID.
		// Skipped for inline types, where no filename is shown to anyone.
		let filename: string | null = null;
		if (disposition === "attachment") {
			// A failed lookup must not fail the download: naming the file is a
			// nicety, and media with no row is served under the bare disposition.
			try {
				filename = await new MediaRepository(emdash.db).findFilenameByStorageKey(key);
			} catch {
				filename = null;
			}
		}
		headers["Content-Disposition"] = contentDisposition(disposition, filename);

		const body = request.method === "HEAD" ? null : (content ?? null);

		if (served) {
			const end = served.offset + served.length - 1;
			headers["Content-Range"] = `bytes ${served.offset}-${end}/${result.size}`;
			headers["Content-Length"] = String(served.length);
			const response = new Response(body, { status: 206, headers });
			if (body) unusedBody = undefined;
			return response;
		}

		if (result.size) {
			headers["Content-Length"] = String(result.size);
		}

		const response = new Response(body, { status: 200, headers });
		if (body) unusedBody = undefined;
		return response;
	} catch (error) {
		// Check if it's a "not found" error
		if (
			error instanceof Error &&
			(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
		) {
			return apiError("NOT_FOUND", "File not found", 404);
		}
		return handleError(error, "Failed to serve file", "FILE_SERVE_ERROR");
	} finally {
		if (unusedBody && !unusedBody.locked) await unusedBody.cancel().catch(() => undefined);
	}
};
