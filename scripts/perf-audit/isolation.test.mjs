import assert from "node:assert/strict";
import { test } from "node:test";

import { contentWrites, writtenTables } from "./isolation.mjs";

const event = (rawSql) => ({ rawSql, sql: rawSql });

test("content writes are found and bookkeeping and reads are not", () => {
	const events = [
		event('select "id", "updated_at", "deleted_at" from "ec_posts" where "id" = ?'),
		event('insert into "_emdash_entry_locks" ("entry_id") values (?)'),
		event('update "_emdash_entry_locks" set "expires_at" = ?'),
		event('update "ec_posts" set "title" = ? where "id" = ?'),
		event('insert or replace into "options" ("name", "value") values (?, ?)'),
		event('delete from "revisions" where "id" = ?'),
		event('with "old" as (select 1) update "users" set "role" = ?'),
		event('create table "ec_empty_desktop" ("id" text primary key)'),
	];
	const writes = contentWrites(events);
	assert.equal(writes.length, 5);
	assert.deepEqual(writtenTables(writes), [
		"?",
		"ec_empty_desktop",
		"ec_posts",
		"options",
		"revisions",
	]);
});
