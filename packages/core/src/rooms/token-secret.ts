import type { Kysely } from "kysely";

import { resolveSecretsCached } from "../config/secrets.js";
import type { Database } from "../database/types.js";
import { roomTokenSecret } from "./token.js";

/** The key room tokens are signed with, from the site's preview secret. */
export async function resolveRoomTokenSecret(db: Kysely<Database>): Promise<string> {
	return roomTokenSecret((await resolveSecretsCached(db)).previewSecret);
}
