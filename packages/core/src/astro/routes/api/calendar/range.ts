/**
 * Calendar range endpoint
 *
 * GET /_emdash/api/calendar/range - The first events in a time range, in one response
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleCalendarRange } from "#api/handlers/calendar.js";
import { isParseError, parseQuery } from "#api/parse.js";
import { calendarRangeQuery } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "content:read_drafts");
	if (denied) return denied;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const query = parseQuery(url, calendarRangeQuery);
	if (isParseError(query)) return query;

	try {
		return unwrapResult(await handleCalendarRange(emdash.db, query));
	} catch (error) {
		return handleError(error, "Failed to load calendar", "CALENDAR_ERROR");
	}
};
