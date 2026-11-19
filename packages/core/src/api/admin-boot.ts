import { hasPermission, type User } from "@emdash-cms/auth";

import { ADMIN_BOOT_DATA_ID } from "#api/admin-boot-id.js";
import { buildAdminManifest } from "#api/admin-manifest.js";
import { type AuthModeInfo, loadAuthModeInfo } from "#api/auth-mode-info.js";
import { type CurrentUserData, loadCurrentUserData } from "#api/current-user.js";
import { handleCommentCounts } from "#api/handlers/comments.js";

import type { EmDashHandlers, EmDashManifest } from "../astro/types.js";
import type { CommentStatus } from "../database/repositories/comment.js";
import { safeJsonLdSerialize } from "../page/metadata.js";

/**
 * What `/api/manifest`, `/api/auth/me` and, for moderators, the sidebar's
 * `/api/admin/comments/counts` would answer for the signed-in user.
 */
export interface AdminBootData {
	manifest: EmDashManifest;
	currentUser: CurrentUserData;
	commentCounts?: Record<CommentStatus, number>;
}

/** What `/api/auth/mode` would answer, for the login page of a signed-out request. */
export interface SignedOutAdminBootData {
	authMode: AuthModeInfo;
}

/**
 * The admin page's boot data. A signed-out request gets it only on the login
 * page, the one signed-out screen that asks for the auth mode. Never rejects:
 * the admin fetches what is missing itself.
 */
export async function loadAdminBootData(
	locals: {
		user?: User;
		emdash?: EmDashHandlers;
		__playgroundDb?: unknown;
	},
	routePath: string,
): Promise<AdminBootData | SignedOutAdminBootData | null> {
	const { user, emdash } = locals;
	if (!emdash) return null;
	if (!user) {
		const onLogin = routePath === "/login" || routePath === "/login/";
		return onLogin ? { authMode: await loadAuthModeInfo(emdash) } : null;
	}
	try {
		const [manifest, currentUser, comments] = await Promise.all([
			buildAdminManifest(emdash),
			loadCurrentUserData(user, locals.__playgroundDb ? emdash.db : undefined),
			hasPermission(user, "comments:moderate") ? handleCommentCounts(emdash.db) : undefined,
		]);
		return comments?.success
			? { manifest, currentUser, commentCounts: comments.data }
			: { manifest, currentUser };
	} catch (error) {
		console.error("[emdash] Failed to embed the admin boot data:", error);
		return null;
	}
}

/**
 * The boot data as a JSON script element. Collection labels and site titles
 * are user input, so `<`, `>` and `&` are escaped to keep them from closing
 * the element or opening a comment.
 */
export function adminBootDataScript(data: AdminBootData | SignedOutAdminBootData | null): string {
	if (!data) return "";
	const json = safeJsonLdSerialize(data).replaceAll("&", "\\u0026");
	return `<script type="application/json" id="${ADMIN_BOOT_DATA_ID}">${json}</script>`;
}
