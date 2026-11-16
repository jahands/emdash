/** The realtime hub's address, for hosts that must not load the hub to route its sockets. */

/** The hub's name in the room namespace. Room IDs start with a collection slug, so none is this. */
export const HUB_NAME = "_realtime";

const REALTIME_PATH = /\/_emdash\/api\/realtime$/;

/** Whether a path is the hub's socket and ticket route, `/_emdash/api/realtime` under any base path. */
export function isRealtimePath(pathname: string): boolean {
	return REALTIME_PATH.test(pathname);
}
