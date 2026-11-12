/**
 * Cloudflare image endpoint -- the `image.endpoint` EmDash installs under the
 * Cloudflare adapter.
 *
 * For an EmDash media URL it reads the source bytes straight from the storage
 * adapter (the R2 binding) and resizes them with the Cloudflare `IMAGES`
 * binding -- no HTTP fetch, so it works behind Cloudflare Access and with
 * `global_fetch_strictly_public`. Every other image is delegated to the
 * adapter's stock transform endpoint unchanged (bundled assets via the `ASSETS`
 * binding, allowed-remote via fetch).
 */

// @astrojs/cloudflare's binding-mode transform endpoint; resolved in the consumer.
import { GET as adapterGET } from "@astrojs/cloudflare/image-transform-endpoint";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import type { Storage } from "emdash";
import {
	getMediaVersion,
	getTransformFingerprint,
	matchInternalMediaKey,
	mediaCacheControl,
	MUTABLE_MEDIA_CACHE_CONTROL,
	originalMediaHeaders,
	parseTransformParams,
	resolveOriginalBody,
	resolveTransformQuality,
	shouldVerifyMedia,
	validatorHeaders,
	isNotModified,
	type ImageTransformFormat,
} from "emdash/media/image-endpoint";

export const prerender = false;

const FORMAT_MIME: Record<ImageTransformFormat, ImageOutputOptions["format"]> = {
	webp: "image/webp",
	avif: "image/avif",
	jpeg: "image/jpeg",
	png: "image/png",
};

/** Resolve the Images binding by the name the Cloudflare adapter configured. */
function resolveImagesBinding(): ImagesBinding | undefined {
	const configured = (globalThis as { __ASTRO_IMAGES_BINDING_NAME?: unknown })
		.__ASTRO_IMAGES_BINDING_NAME;
	const name = typeof configured === "string" && configured ? configured : "IMAGES";
	// env from cloudflare:workers has no index signature, so a cast is needed.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Images binding accessed from untyped env object
	return (env as Record<string, unknown>)[name] as ImagesBinding | undefined;
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
 * version. A derivative's 304 omits Content-Type so the stored response keeps
 * its output format's type.
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

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message.includes("not found") || error.message.includes("NOT_FOUND"))
	);
}

export const GET: APIRoute = async (ctx) => {
	const url = new URL(ctx.request.url);
	const href = url.searchParams.get("href");
	const key = matchInternalMediaKey(href);
	// App.Locals.emdash is augmented by `emdash/locals`, not loaded in this
	// package's compilation; narrow to the fields we need.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- App.Locals augmentation lives in the emdash package
	const emdash = (ctx.locals as { emdash?: { storage?: Storage | null } }).emdash;
	const storage = emdash?.storage;

	// Not EmDash media, or storage unavailable: let the adapter's endpoint handle
	// it (bundled assets via ASSETS, allowed remote via fetch).
	if (!key || !storage) return adapterGET(ctx);

	// An unread download keeps its storage read open even for a bodyless response.
	let unusedBody: ReadableStream<Uint8Array> | undefined;
	const version = getMediaVersion(href);

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

		const images = resolveImagesBinding();
		const parsed = parseTransformParams(url.searchParams);

		// No binding or unparseable params: serve the original so the URL resolves.
		if (!images || !parsed.ok) return await serveOriginal();

		const fingerprint = getTransformFingerprint(url.searchParams);
		if (isNotModified(ctx.request, source.size, source.lastModified, fingerprint)) {
			return notModifiedResponse(source, fingerprint);
		}

		const { width, height, format, quality } = parsed.options;
		const outputMime = FORMAT_MIME[format] ?? "image/webp";
		const transform: ImageTransform = {};
		if (width) transform.width = width;
		if (height) transform.height = height;
		// Lossy formats get an explicit quality: the Images binding has no
		// default of its own and encodes near-losslessly without one, producing
		// renditions several times the size of the original. PNG is exempt —
		// an explicit PNG quality switches the binding to lossy PNG8, which is
		// not a safe default for a lossless format. An explicit `q=` always wins.
		const output: ImageOutputOptions = { format: outputMime };
		const effectiveQuality = resolveTransformQuality(format, quality);
		if (effectiveQuality !== undefined) output.quality = effectiveQuality;

		let input = source.body;
		let cacheControl = MUTABLE_MEDIA_CACHE_CONTROL;
		if (shouldVerifyMedia(version, source.size)) {
			const bytes = new Uint8Array(await new Response(source.body).arrayBuffer());
			cacheControl = await mediaCacheControl(version, bytes);
			input = new Blob([bytes]).stream();
		}
		const result = await images.input(input).transform(transform).output(output);
		unusedBody = undefined;
		const response = result.response();
		if (!response.body) return new Response(null, { status: 500 });

		return new Response(response.body, {
			status: 200,
			headers: {
				"Content-Type": response.headers.get("Content-Type") ?? outputMime,
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
