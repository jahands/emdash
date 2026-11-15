import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { EmDashConfig } from "../astro/integration/runtime.js";
import { getAuthMode } from "../auth/mode.js";
import type { Database } from "../database/types.js";

/** What the login page needs to choose its sign-in screen. */
export interface AuthModeInfo {
	authMode: string;
	signupEnabled: boolean;
	providers: Array<{ id: string; label: string }>;
}

/** The public `/api/auth/mode` answer. Never rejects. */
export async function loadAuthModeInfo(emdash: {
	db?: Kysely<Database>;
	config?: EmDashConfig;
}): Promise<AuthModeInfo> {
	const authMode = getAuthMode(emdash.config);

	// External providers handle their own signup.
	let signupEnabled = false;
	if (emdash.db && authMode.type === "passkey") {
		try {
			const result = await sql<{ cnt: unknown }>`
				SELECT COUNT(*) as cnt FROM allowed_domains WHERE enabled = 1
			`.execute(emdash.db);
			signupEnabled = Number(result.rows[0]?.cnt ?? 0) > 0;
		} catch {
			// Table may not exist yet
		}
	}

	return {
		authMode: authMode.type === "external" ? authMode.providerType : "passkey",
		signupEnabled,
		providers: (emdash.config?.authProviders ?? []).map((p) => ({ id: p.id, label: p.label })),
	};
}
