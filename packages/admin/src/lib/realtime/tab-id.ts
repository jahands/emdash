/**
 * This tab's ID. `apiFetch` sends it, and the server copies it into the changes the tab's requests
 * make, so the tab skips changes it already knows about. `crypto.randomUUID` needs a secure
 * context, which an admin served over plain HTTP on a LAN address isn't.
 */
export const TAB_ID = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
	byte.toString(16).padStart(2, "0"),
).join("");

export const TAB_ID_HEADER = "X-EmDash-Client";
