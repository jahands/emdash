/**
 * Cloudflare image endpoint for URL-based image transformations -- the
 * `image.endpoint` EmDash installs when the Cloudflare adapter's `imageService`
 * is `"cloudflare"`, which has no `IMAGES` binding to transform with.
 *
 * A rendition of EmDash media is redirected to the zone's `/cdn-cgi/image/`
 * URL for the site's own media file route, so Cloudflare resizes it at the edge
 * and caches the result. Only safe EmDash media keys are redirected, and only to
 * that route, so the endpoint never transforms or fetches an arbitrary URL.
 * Every other request is handled as in binding mode.
 */

import type { APIRoute } from "astro";
import {
	buildImageResizingUrl,
	getMediaVersion,
	IMMUTABLE_IMAGE_CACHE,
	matchInternalMediaKey,
	MUTABLE_MEDIA_CACHE_CONTROL,
	parseTransformParams,
} from "emdash/media/image-endpoint";

import { GET as bindingGET } from "./image-endpoint.js";

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
	const url = new URL(ctx.request.url);
	const href = url.searchParams.get("href");
	const key = matchInternalMediaKey(href);
	const parsed = parseTransformParams(url.searchParams);
	if (!key || !parsed.ok) return bindingGET(ctx);

	const version = getMediaVersion(href);
	const location = buildImageResizingUrl(key, parsed.options, version);
	if (!location) return bindingGET(ctx);

	// A version-pinned URL always names the same file, so its redirect never changes.
	return new Response(null, {
		status: 302,
		headers: {
			Location: location,
			"Cache-Control": version ? IMMUTABLE_IMAGE_CACHE : MUTABLE_MEDIA_CACHE_CONTROL,
		},
	});
};
