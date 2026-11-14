import type { User } from "@emdash-cms/auth";

import { ADMIN_BOOT_DATA_ID } from "#api/admin-boot-id.js";
import { buildAdminManifest } from "#api/admin-manifest.js";
import { type CurrentUserData, loadCurrentUserData } from "#api/current-user.js";

import type { EmDashHandlers, EmDashManifest } from "../astro/types.js";
import { safeJsonLdSerialize } from "../page/metadata.js";

/** What `/api/manifest` and `/api/auth/me` would answer for the signed-in user. */
export interface AdminBootData {
	manifest: EmDashManifest;
	currentUser: CurrentUserData;
}

/**
 * The admin page's boot data for a signed-in request, or `null` for an
 * anonymous one. Never rejects: the admin fetches what is missing itself.
 */
export async function loadAdminBootData(locals: {
	user?: User;
	emdash?: EmDashHandlers;
	__playgroundDb?: unknown;
}): Promise<AdminBootData | null> {
	const { user, emdash } = locals;
	if (!user || !emdash) return null;
	try {
		const [manifest, currentUser] = await Promise.all([
			buildAdminManifest(emdash),
			loadCurrentUserData(user, locals.__playgroundDb ? emdash.db : undefined),
		]);
		return { manifest, currentUser };
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
export function adminBootDataScript(data: AdminBootData | null): string {
	if (!data) return "";
	const json = safeJsonLdSerialize(data).replaceAll("&", "\\u0026");
	return `<script type="application/json" id="${ADMIN_BOOT_DATA_ID}">${json}</script>`;
}
