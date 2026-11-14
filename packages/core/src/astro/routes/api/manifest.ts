/**
 * Admin manifest endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/manifest
 *
 * Returns the admin manifest with collection definitions and plugin info.
 * The manifest is generated from live database schema plus runtime plugin state.
 *
 * The response carries an ETag of its body and must be revalidated on every
 * use, so an unchanged manifest costs a 304 instead of a download, and a
 * changed one is never served stale.
 */

import type { APIRoute } from "astro";

import { buildAdminManifest } from "#api/admin-manifest.js";
import { handleError } from "#api/error.js";

import { hashString } from "../../../utils/hash.js";

export const prerender = false;

const MANIFEST_CACHE_CONTROL = "private, no-cache";

const WEAK_ETAG_PREFIX = /^W\//;

function opaqueTag(tag: string): string {
	return tag.trim().replace(WEAK_ETAG_PREFIX, "");
}

/** Whether an `If-None-Match` header lists `etag` (weak comparison). */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
	if (!ifNoneMatch) return false;
	return ifNoneMatch
		.split(",")
		.some((tag) => tag.trim() === "*" || opaqueTag(tag) === opaqueTag(etag));
}

export const GET: APIRoute = async ({ locals, request }) => {
	try {
		const manifest = await buildAdminManifest(locals.emdash);
		const body = JSON.stringify({ success: true, data: manifest });
		const etag = `W/"${await hashString(body)}"`;
		const headers = { "Cache-Control": MANIFEST_CACHE_CONTROL, ETag: etag };
		if (matchesEtag(request.headers.get("If-None-Match"), etag)) {
			return new Response(null, { status: 304, headers });
		}
		return new Response(body, {
			headers: { ...headers, "Content-Type": "application/json" },
		});
	} catch (error) {
		return handleError(error, "Failed to build manifest", "MANIFEST_BUILD_ERROR");
	}
};
