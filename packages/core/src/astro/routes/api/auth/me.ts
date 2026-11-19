/**
 * GET /_emdash/api/auth/me
 *
 * Returns the current authenticated user's info, welcome state, and personal
 * sidebar layout.
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { loadCurrentUserData } from "#api/current-user.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody, validate } from "#api/parse.js";
import { authMeActionBody, setAdminLayoutBody } from "#api/schemas.js";
import { UserRepository } from "#db/repositories/user.js";

export const GET: APIRoute = async ({ locals }) => {
	const { user, emdash } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}
	if (locals.__playgroundDb && !emdash) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		return apiSuccess(
			await loadCurrentUserData(user, locals.__playgroundDb ? emdash?.db : undefined),
		);
	} catch (error) {
		return handleError(error, "Failed to fetch current user", "CURRENT_USER_ERROR");
	}
};

/**
 * POST /_emdash/api/auth/me
 *
 * - `{ action: "dismissWelcome" }` marks the welcome modal as seen.
 * - `{ action: "setAdminLayout", adminLayout }` replaces the personal sidebar
 *   layout, or removes it when `adminLayout` is `null`.
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { user, emdash } = locals;

	if (!user) {
		return apiError("NOT_AUTHENTICATED", "Not authenticated", 401);
	}

	if (!emdash) return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);

	const body = await parseBody(request, authMeActionBody);
	if (isParseError(body)) return body;

	const users = new UserRepository(emdash.db);

	switch (body.action) {
		case "dismissWelcome": {
			try {
				// Persist in the user's data column so it survives session expiry.
				await users.setDataKey(user.id, "welcomeDismissed", true);
				return apiSuccess({ success: true });
			} catch (error) {
				return handleError(error, "Failed to dismiss welcome", "WELCOME_DISMISS_ERROR");
			}
		}

		case "setAdminLayout": {
			const input = validate(setAdminLayoutBody, body);
			if (isParseError(input)) return input;
			try {
				if (input.adminLayout) {
					await users.setDataKey(user.id, "adminLayout", input.adminLayout);
				} else {
					await users.removeDataKey(user.id, "adminLayout");
				}
				return apiSuccess({ adminLayout: input.adminLayout });
			} catch (error) {
				return handleError(error, "Failed to save admin layout", "ADMIN_LAYOUT_SAVE_ERROR");
			}
		}

		default:
			return apiError("UNKNOWN_ACTION", "Unknown action", 400);
	}
};
