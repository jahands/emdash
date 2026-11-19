/**
 * GET /_emdash/api/auth/mode
 *
 * Public endpoint that returns the active authentication mode.
 * Used by the login page to determine which login UI to render.
 *
 * Unlike the full manifest endpoint, this is intentionally public
 * and returns only the auth mode — no collection schemas, plugin
 * info, or other internal details.
 */

import type { APIRoute } from "astro";

import { loadAuthModeInfo } from "#api/auth-mode-info.js";
import { apiSuccess } from "#api/error.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	return apiSuccess(await loadAuthModeInfo(locals.emdash ?? {}));
};
