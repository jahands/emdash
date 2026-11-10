import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { beforeAll, beforeEach, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { EntryLockRepository } from "../../src/database/repositories/entry-locks.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	await db
		.insertInto("users")
		.values({ id: "user-ada", email: "ada@example.com", name: "Ada", role: 40, email_verified: 1 })
		.execute();
});

it("returns the lock holder's name from the claim on D1", async () => {
	const claim = await new EntryLockRepository(db).acquire({
		collection: "posts",
		entryId: "entry-1",
		userId: "user-ada",
		token: "tab-1",
		leaseSeconds: 300,
	});

	expect(claim).toMatchObject({
		outcome: "acquired",
		lock: { userId: "user-ada", userName: "Ada" },
	});
});
