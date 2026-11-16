/**
 * Realtime hub tickets.
 */

import type { RoleLevel } from "@emdash-cms/auth";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { HUB_NAME } from "../../realtime/path.js";
import { resolveRoomTokenSecret } from "../../rooms/token-secret.js";
import { signRoomToken } from "../../rooms/token.js";
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
	user: { id: string; role: RoleLevel } | null | undefined;
	/** Whether this host runs a hub. */
	live: boolean;
	/** The site's base path without a trailing slash. */
	basePath: string;
}

/** Signs a ticket for the hub's socket, bound to the user and their role. Runs no query of its own. */
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
