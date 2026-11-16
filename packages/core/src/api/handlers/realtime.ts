/**
 * Realtime hub tickets.
 */

import type { RoleLevel } from "@emdash-cms/auth";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { isClientId } from "../../realtime/publish.js";
import { capUserName } from "../../rooms/limits.js";
import { resolveRoomTokenSecret } from "../../rooms/token-secret.js";
import { signRoomToken } from "../../rooms/token.js";
import { HUB_NAME } from "../../rooms/types.js";
import { ROOM_TOKEN_BYTES } from "../../rooms/types.js";
import { ErrorCode } from "../errors.js";
import type { ApiResult } from "../types.js";

/**
 * Hosts verify a ticket before the hub sees it, so it can't be single use there. The hub
 * remembers used nonces while it stays in memory, and the short lifetime bounds a replay after.
 */
const TICKET_LIFETIME_MS = 30_000;

export type RealtimeTicketResult =
	| { mode: "live"; url: string; ticket: string }
	/** This host runs no hub. */
	| { mode: "off" };

export interface RealtimeTicketInput {
	user: { id: string; role: RoleLevel; name: string | null; email: string } | null | undefined;
	/** The `X-EmDash-Client` header: the tab, which the hub keys its presence by. */
	clientId: string | null;
	/** Whether this host runs a hub. */
	live: boolean;
	/** The site's base path without a trailing slash. */
	basePath: string;
	/** The permission each plugin channel needs, by `pluginChannelKey`, which the hub checks. */
	channels?: Record<string, string>;
}

/**
 * Signs a ticket for the hub's socket, bound to the user, their role and name, the tab, and the
 * permissions of plugin channels. Runs no query of its own.
 */
export async function handleRealtimeTicket(
	db: Kysely<Database>,
	input: RealtimeTicketInput,
): Promise<ApiResult<RealtimeTicketResult>> {
	const { user } = input;
	if (!user) {
		return {
			success: false,
			error: { code: ErrorCode.UNAUTHORIZED, message: "Authentication required" },
		};
	}
	if (!input.live) return { success: true, data: { mode: "off" } };
	try {
		const ticket = await signRoomToken(await resolveRoomTokenSecret(db), {
			roomId: HUB_NAME,
			userId: user.id,
			nonce: encodeBase64urlNoPadding(crypto.getRandomValues(new Uint8Array(ROOM_TOKEN_BYTES))),
			expiresAt: Date.now() + TICKET_LIFETIME_MS,
			role: user.role,
			name: capUserName(user.name || user.email),
			clientId: isClientId(input.clientId) ? input.clientId : undefined,
			channels:
				input.channels && Object.keys(input.channels).length > 0 ? input.channels : undefined,
		});
		return {
			success: true,
			data: { mode: "live", url: `${input.basePath}/_emdash/api/realtime`, ticket },
		};
	} catch (error) {
		console.error("[realtime] couldn't sign a ticket:", error);
		return {
			success: false,
			error: { code: "REALTIME_TICKET_ERROR", message: "Failed to issue a live updates ticket" },
		};
	}
}
