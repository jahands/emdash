/**
 * Signed room tokens. The join route signs the nonce a room issues, bound to the room and the
 * user, so a host can refuse an upgrade before it reaches a room. The room still forgets a nonce
 * once used, so a token is single use while the room stays in memory.
 */

import { decodeBase64urlIgnorePadding, encodeBase64urlNoPadding } from "@oslojs/encoding";

const DOMAIN = "emdash:room-token:v1:";
/** Far longer than any token the join route signs, so a huge query string is refused unread. */
const MAX_TOKEN_LENGTH = 2048;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RoomTokenClaims {
	roomId: string;
	userId: string;
	/** The nonce the room issued. */
	nonce: string;
	/** In ms since the epoch. */
	expiresAt: number;
}

/** The token key for a site's preview secret, separate from the keys other tokens use. */
export function roomTokenSecret(previewSecret: string): string {
	return `${DOMAIN}${previewSecret}`;
}

export async function signRoomToken(secret: string, claims: RoomTokenClaims): Promise<string> {
	const payload = encodeBase64urlNoPadding(
		encoder.encode(
			JSON.stringify({
				r: claims.roomId,
				u: claims.userId,
				n: claims.nonce,
				e: claims.expiresAt,
			}),
		),
	);
	const key = await importKey(secret, "sign");
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	return `${payload}.${encodeBase64urlNoPadding(new Uint8Array(signature))}`;
}

/**
 * A token's claims without checking its signature, or null when it doesn't parse. Only for a
 * room behind a host that verified the token.
 */
export function readRoomToken(token: string): RoomTokenClaims | null {
	if (token.length > MAX_TOKEN_LENGTH) return null;
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(decodeBase64urlIgnorePadding(token.slice(0, dot))));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	if (!("r" in parsed && "u" in parsed && "n" in parsed && "e" in parsed)) return null;
	const { r, u, n, e } = parsed;
	if (typeof r !== "string" || typeof u !== "string" || typeof n !== "string") return null;
	if (typeof e !== "number" || !Number.isFinite(e)) return null;
	return { roomId: r, userId: u, nonce: n, expiresAt: e };
}

/**
 * The claims of a token signed for `roomId` that hasn't expired, or null. `secret` is called only
 * once the token's claims pass, so a malformed or expired token costs no secret lookup.
 */
export async function verifyRoomToken(
	token: string,
	roomId: string,
	secret: () => Promise<string>,
	now = Date.now(),
): Promise<RoomTokenClaims | null> {
	const claims = readRoomToken(token);
	if (!claims || claims.roomId !== roomId || claims.expiresAt <= now) return null;
	const dot = token.indexOf(".");
	let signature: Uint8Array;
	try {
		signature = decodeBase64urlIgnorePadding(token.slice(dot + 1));
	} catch {
		return null;
	}
	const key = await importKey(await secret(), "verify");
	const valid = await crypto.subtle.verify(
		"HMAC",
		key,
		new Uint8Array(signature),
		encoder.encode(token.slice(0, dot)),
	);
	return valid ? claims : null;
}

function importKey(secret: string, use: "sign" | "verify"): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		[use],
	);
}
