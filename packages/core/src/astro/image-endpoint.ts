/**
 * Node image endpoint -- the `image.endpoint` EmDash installs on non-Cloudflare
 * platforms whose image service is local (sharp).
 *
 * It wraps Astro's generic endpoint: for an EmDash media URL it loads the source
 * bytes straight from the storage adapter (no HTTP, so it works behind any auth
 * gate) and runs the configured image service's `transform`; every other image
 * is delegated to the stock endpoint unchanged.
 */

import type { APIRoute } from "astro";
// @ts-ignore - astro/assets internal endpoint, resolved by the consumer's Astro build
import { GET as genericGET } from "astro/assets/endpoint/generic";
// @ts-ignore - astro:assets is resolved by the consumer's Astro build
import { getConfiguredImageService, imageConfig } from "astro:assets";

import {
	getMediaVersion,
	getTransformFingerprint,
	matchInternalMediaKey,
	mediaCacheControl,
	MUTABLE_MEDIA_CACHE_CONTROL,
	originalMediaHeaders,
	resolveOriginalBody,
	validatorHeaders,
	isNotModified,
} from "../media/image-endpoint.js";

export const prerender = false;

const FORMAT_MIME: Record<string, string> = {
	webp: "image/webp",
	avif: "image/avif",
	png: "image/png",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	gif: "image/gif",
};

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
	);
}

interface StoredSource {
	body: ReadableStream<Uint8Array>;
	contentType: string;
	size: number;
	lastModified?: Date;
}

/**
 * A 304 carries the validators of the 200 it revalidates. It always revalidates
 * because it is sent without reading the bytes, so it can't verify a pinned
 * version. A derivative's 304 omits Content-Type: the stored response's type
 * (the output format) must survive revalidation, and only the transform knows it.
 */
function notModifiedResponse(source: StoredSource, suffix?: string): Response {
	return new Response(null, {
		status: 304,
		headers: {
			...(suffix === undefined ? { "Content-Type": source.contentType } : {}),
			"Cache-Control": MUTABLE_MEDIA_CACHE_CONTROL,
			"X-Content-Type-Options": "nosniff",
			...validatorHeaders(source.size, source.lastModified, suffix),
		},
	});
}

export const GET: APIRoute = async (ctx) => {
	const url = new URL(ctx.request.url);
	const key = matchInternalMediaKey(url.searchParams.get("href"));
	const emdash = ctx.locals.emdash;
	const storage = emdash?.storage;

	// Not EmDash media, or storage unavailable: let the stock endpoint handle it
	// (bundled assets, allowed remote, `publicUrl` media).
	if (!key || !emdash || !storage) return genericGET(ctx);

	const service = await getConfiguredImageService();
	if (!("transform" in service)) return genericGET(ctx);

	// An unread download retains its storage connection even for a bodyless response.
	let unusedBody: ReadableStream<Uint8Array> | undefined;
	const version = getMediaVersion(url.searchParams.get("href"));
	try {
		const source = await storage.download(key);
		unusedBody = source.body;

		const serveOriginal = async (): Promise<Response> => {
			if (isNotModified(ctx.request, source.size, source.lastModified)) {
				return notModifiedResponse(source);
			}
			const original = await resolveOriginalBody(version, source.body, source.size);
			const headers = originalMediaHeaders(
				source.contentType,
				source.size,
				source.lastModified,
				original.cacheControl,
			);
			if (ctx.request.method === "HEAD") return new Response(null, { status: 200, headers });
			unusedBody = undefined;
			return new Response(original.body, { status: 200, headers });
		};

		// Only raster images are transformable; serve anything else unchanged.
		if (!source.contentType.startsWith("image/")) return await serveOriginal();

		const transform = await service.parseURL(url, imageConfig);
		if (!transform) return await serveOriginal();

		const fingerprint = getTransformFingerprint(url.searchParams);
		if (isNotModified(ctx.request, source.size, source.lastModified, fingerprint)) {
			return notModifiedResponse(source, fingerprint);
		}

		const inputBuffer = new Uint8Array(await new Response(source.body).arrayBuffer());
		const cacheControl = await mediaCacheControl(version, inputBuffer);
		const { data, format } = await service.transform(inputBuffer, transform, imageConfig);

		return new Response(data, {
			status: 200,
			headers: {
				"Content-Type": FORMAT_MIME[format] ?? source.contentType,
				"Cache-Control": cacheControl,
				"X-Content-Type-Options": "nosniff",
				...validatorHeaders(source.size, source.lastModified, fingerprint),
			},
		});
	} catch (error) {
		if (isNotFound(error)) return new Response("Not Found", { status: 404 });
		console.error("[emdash] image transform failed:", error);
		return new Response("Internal Server Error", { status: 500 });
	} finally {
		if (unusedBody && !unusedBody.locked) await unusedBody.cancel().catch(() => undefined);
	}
};
