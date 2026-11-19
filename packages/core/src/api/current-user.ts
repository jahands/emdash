import type { User } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import { adminLayoutSchema } from "#api/schemas.js";
import { UserRepository } from "#db/repositories/user.js";
import type { Database } from "#db/types.js";

/** The signed-in user as `GET /_emdash/api/auth/me` returns it. */
export interface CurrentUserData {
	id: string;
	email: string;
	name: string | null;
	role: number;
	avatarUrl: string | null;
	isFirstLogin: boolean;
	adminLayout: unknown;
}

/**
 * Safe user info, welcome state and personal sidebar layout for `user`. A
 * playground session keeps the user in its own database, so pass that
 * database as `playgroundDb` to read the stored copy.
 */
export async function loadCurrentUserData(
	user: User,
	playgroundDb?: Kysely<Database>,
): Promise<CurrentUserData> {
	let userData = user.data;
	if (playgroundDb) {
		const persistedUser = await new UserRepository(playgroundDb).findById(user.id);
		if (persistedUser) userData = persistedUser.data;
	}

	// Check if this is the user's first login (for welcome modal).
	// The flag is persisted in the user's `data` JSON column so it survives
	// session expiry / rotation.
	const isFirstLogin = !userData?.welcomeDismissed;
	const adminLayout = adminLayoutSchema.safeParse(userData?.adminLayout);

	return {
		id: user.id,
		email: user.email,
		name: user.name,
		role: user.role,
		avatarUrl: user.avatarUrl,
		isFirstLogin,
		adminLayout: adminLayout.success ? adminLayout.data : null,
	};
}
