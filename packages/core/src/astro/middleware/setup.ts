/**
 * Setup detection middleware
 *
 * Redirects to setup wizard if the site hasn't been set up yet.
 * Checks both "emdash:setup_complete" option AND user existence.
 *
 * Detection logic (in order):
 * 1. Does options table exist? No → setup needed
 * 2. Is setup_complete true? No → setup needed
 * 3. In passkey mode: Are there any users? No → setup needed
 *    In Access mode: Skip user check (first user created on first login)
 * 4. Proceed to admin
 *
 * Once a check passes, later requests in the same process skip it (see
 * `setup-state.ts`).
 */

import { defineMiddleware } from "astro:middleware";
import { sql } from "kysely";

import { getAuthMode } from "../../auth/mode.js";
import { confirmSetupComplete, isSetupConfirmed } from "../setup-state.js";

function isSetupFlagSet(value: string | null | undefined): boolean {
	if (!value) return false;
	// Value is JSON-encoded. Accepts both boolean true and string "true".
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed === true || parsed === "true";
	} catch {
		return false;
	}
}

export const onRequest = defineMiddleware(async (context, next) => {
	// Only check setup on admin routes (but not the setup page itself)
	const isAdminRoute = context.url.pathname.startsWith("/_emdash/admin");
	const isSetupRoute = context.url.pathname.startsWith("/_emdash/admin/setup");

	if (isAdminRoute && !isSetupRoute) {
		const { emdash } = context.locals;

		if (!emdash?.db) {
			// No database configured - let the admin handle this error
			return next();
		}

		const config = emdash.config;
		if (isSetupConfirmed(config)) return next();

		try {
			// In Access mode, skip the user check - first user is created on first
			// Access login. In passkey mode, setup_complete with no users is a
			// recoverable half-state that needs the admin step of the wizard.
			const requireUsers = getAuthMode(config).type === "passkey";
			const { rows } = await sql<{ setup_complete: string | null; has_users: unknown }>`
				SELECT
					(SELECT value FROM options WHERE name = ${"emdash:setup_complete"}) AS setup_complete,
					${requireUsers ? sql`(SELECT 1 FROM users LIMIT 1)` : sql`1`} AS has_users
			`.execute(emdash.db);
			const row = rows[0];

			if (!isSetupFlagSet(row?.setup_complete) || row?.has_users == null) {
				return context.redirect("/_emdash/admin/setup");
			}
			confirmSetupComplete(config);
		} catch (error) {
			// If the options table doesn't exist yet, redirect to setup
			// This handles fresh installations where migrations haven't run
			if (error instanceof Error && error.message.includes("no such table")) {
				return context.redirect("/_emdash/admin/setup");
			}

			// Other errors - let the admin handle them
			console.error("Setup middleware error:", error);
		}
	}

	return next();
});
