/** Co-editing timings and limits. */

const MB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Largest update a client can send, encoded. */
export const MAX_UPDATE_BYTES = MB;
/** Largest stored entry a room initializes from. */
export const MAX_ENTRY_BYTES = MB;
/** Largest compacted document. Past it, the room saves and drops. */
export const MAX_COMPACTED_BYTES = 2 * MB;
/** Largest recovery revision, as stored data. Under D1's 2,000,000-byte row limit. */
export const MAX_RECOVERY_BYTES = 1_900_000;
export const MAX_ROOM_CONNECTIONS = 25;
/**
 * Longest user name a connection keeps, in code points. A Durable Object keeps it in the socket's
 * attachment, which can't pass 16 KiB serialized.
 */
export const MAX_USER_NAME_LENGTH = 256;

/** The name cut to `MAX_USER_NAME_LENGTH` code points. */
export function capUserName(name: string): string {
	if (name.length <= MAX_USER_NAME_LENGTH) return name;
	let end = 0;
	let count = 0;
	for (const char of name) {
		if (count++ === MAX_USER_NAME_LENGTH) break;
		end += char.length;
	}
	return name.slice(0, end);
}
export const MAX_USER_CONNECTIONS = 5;
/** A token is single use, and valid this long. */
export const TOKEN_LIFETIME_MS = MINUTE;
/** Older connections are closed with `rejoin` at the next message or hourly drop. */
export const CONNECTION_LIFETIME_MS = 15 * MINUTE;
/** Updates are stored within this long. */
export const STORE_DELAY_MS = SECOND;
/** Appended updates past this are compacted. Also the size of each stored part. */
export const COMPACTION_BYTES = MB;
/** The room saves this long after the latest co-editor update. */
export const SAVE_DELAY_MS = 2 * SECOND;
/** Longest wait between saves while co-editor updates keep arriving. */
export const MAX_SAVE_INTERVAL_MS = 10 * SECOND;
/** Saves the site couldn't take are tried again this many times, backing off up to the interval. */
export const MAX_SAVE_RETRIES = 5;
/** A site call that hasn't settled by then counts as failed, so the room's queue moves on. */
export const SITE_CALL_TIMEOUT_MS = 20 * SECOND;
export const OPERATION_HOLD_MS = 30 * SECOND;
/** A room stays open this long after its last connection closes. */
export const OPEN_AFTER_LAST_CONNECTION_MS = 10 * SECOND;
/** Stored room state lasts this long after the last store or closed connection. */
export const ROOM_STATE_LIFETIME_MS = 60 * MINUTE;
/** A Node.js process renews each claim it holds at least this often. */
export const CLAIM_RENEWAL_MS = 20 * SECOND;
/** A Node.js claim not renewed for this long can be taken by another process. */
export const CLAIM_EXPIRY_MS = MINUTE;
/** Longest a Node.js process waits for its rooms to shut down after `SIGTERM` or `SIGINT`. */
export const SHUTDOWN_WAIT_MS = 5 * SECOND;
/** A Node.js process with no server this long after its first token issues no more tokens. */
export const SERVER_WAIT_MS = MINUTE;
