/**
 * SQLite runtime adapter
 *
 * Creates a Kysely dialect for Node's built-in SQLite driver.
 * Loaded at runtime via virtual module.
 */

import type { Dialect } from "kysely";

import type { SqliteConfig } from "./adapters.js";
import { NodeSqliteDialect, openNodeSqliteDatabase } from "./node-sqlite-compat.js";

/**
 * Create a SQLite dialect from config
 */
export function createDialect(config: SqliteConfig): Dialect {
	// Parse URL to get file path
	const url = config.url;
	const filePath = url.startsWith("file:") ? url.slice(5) : url;

	const database = openNodeSqliteDatabase(filePath, { journalMode: "wal" });

	return new NodeSqliteDialect({ database });
}
