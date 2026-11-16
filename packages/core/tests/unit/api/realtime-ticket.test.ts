import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleRealtimeTicket } from "../../../src/api/handlers/realtime.js";
import type { Database } from "../../../src/database/types.js";
import { MAX_USER_NAME_LENGTH } from "../../../src/rooms/limits.js";
import { readRoomToken } from "../../../src/rooms/token.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("handleRealtimeTicket", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function claims(user: { name: string | null; email: string }, clientId: string | null) {
		const result = await handleRealtimeTicket(db, {
			user: { id: "01USER", role: Role.EDITOR, ...user },
			clientId,
			live: true,
			basePath: "",
		});
		if (!result.success || result.data.mode !== "live") throw new Error("No ticket");
		return readRoomToken(result.data.ticket);
	}

	it("signs the name the hub shows others, and the tab", async () => {
		expect(await claims({ name: "Ana", email: "ana@example.com" }, "tab-1")).toMatchObject({
			userId: "01USER",
			role: Role.EDITOR,
			name: "Ana",
			clientId: "tab-1",
		});
	});

	it("falls back to the email, caps a long name, and drops a malformed tab", async () => {
		const unnamed = await claims({ name: null, email: "ana@example.com" }, "not a tab id");
		const long = await claims({ name: "界".repeat(1000), email: "ana@example.com" }, null);

		expect(unnamed?.name).toBe("ana@example.com");
		expect(unnamed?.clientId).toBeUndefined();
		expect(long?.name).toBe("界".repeat(MAX_USER_NAME_LENGTH));
	});
});
