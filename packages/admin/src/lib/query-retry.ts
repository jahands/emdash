import { isTerminalRequestError } from "./api/client.js";

export function retryAdminQuery(count: number, error: unknown): boolean {
	return count < 1 && !isTerminalRequestError(error);
}
