/**
 * Live updates
 *
 * POST /_emdash/api/realtime - Get a ticket for the realtime hub
 *
 * A client given a ticket opens its WebSocket on this path, with `?token=`.
 */

import type { APIRoute } from "astro";

import { apiError, unwrapResult } from "#api/error.js";
import { handleRealtimeTicket } from "#api/handlers/realtime.js";

import { CLIENT_HEADER } from "../../../realtime/publish.js";

export const prerender = false;

const TRAILING_SLASH_RE = /\/$/;

export const POST: APIRoute = async ({ locals, request }) => {
	const { emdash, user } = locals;
	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (locals.tokenScopes !== undefined) {
		return apiError("FORBIDDEN", "Live updates require a signed-in session", 403);
	}

	return unwrapResult(
		await handleRealtimeTicket(emdash.db, {
			user,
			clientId: request.headers.get(CLIENT_HEADER),
			// A playground session's database isn't the one other tabs' changes come from.
			live: Boolean(emdash.rooms?.publish) && locals.__playgroundDb === undefined,
			basePath: import.meta.env.BASE_URL.replace(TRAILING_SLASH_RE, ""),
			channels: emdash.getRealtimeChannels(),
		}),
	);
};
