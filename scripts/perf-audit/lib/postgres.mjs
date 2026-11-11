/**
 * PostgreSQL for the postgres profiles: the server named by EMDASH_TEST_PG,
 * or a disposable local cluster created with initdb.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { loadPg } from "./deps.mjs";
import { run, waitForPort } from "./proc.mjs";

const CLUSTER_PORT = 14590;
const SAFE_NAME = /^[a-z][a-z0-9_]*$/;

function quoteIdent(name) {
	if (!SAFE_NAME.test(name)) throw new Error(`Unsafe database name: ${name}`);
	return `"${name}"`;
}

export async function startPostgres({ stateDir, log }) {
	if (process.env.EMDASH_TEST_PG) {
		const url = new URL(process.env.EMDASH_TEST_PG);
		return {
			source: "EMDASH_TEST_PG",
			host: url.hostname,
			port: Number(url.port || 5432),
			user: decodeURIComponent(url.username || "postgres"),
			password: decodeURIComponent(url.password || ""),
			stop: async () => {},
		};
	}
	const dataDir = join(stateDir, "postgres-cluster");
	if (!existsSync(join(dataDir, "PG_VERSION"))) {
		mkdirSync(dataDir, { recursive: true });
		run("initdb", ["-D", dataDir, "-U", "postgres", "--auth=trust", "-E", "UTF8"], {
			logStream: log,
		});
	}
	run(
		"pg_ctl",
		[
			"-D",
			dataDir,
			"-l",
			join(stateDir, "postgres.log"),
			"-o",
			`-p ${CLUSTER_PORT} -c unix_socket_directories='' -c listen_addresses=127.0.0.1 -c fsync=off -c max_connections=200`,
			"-w",
			"start",
		],
		{ logStream: log, allowFailure: true },
	);
	await waitForPort(CLUSTER_PORT, { timeoutMs: 30_000 });
	return {
		source: "initdb",
		host: "127.0.0.1",
		port: CLUSTER_PORT,
		user: "postgres",
		// The cluster trusts local connections; Hyperdrive's local mode still
		// insists on a password in the connection string.
		password: "perf-audit",
		stop: async () => {
			run("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"], {
				logStream: log,
				allowFailure: true,
			});
		},
	};
}

export function connectionUrl(pg, { port = pg.port, host = pg.host, database }) {
	const auth = pg.password
		? `${encodeURIComponent(pg.user)}:${encodeURIComponent(pg.password)}`
		: encodeURIComponent(pg.user);
	return `postgres://${auth}@${host}:${port}/${database}`;
}

async function withAdmin(pg, fn) {
	const { Client } = loadPg();
	const client = new Client({ connectionString: connectionUrl(pg, { database: "postgres" }) });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

export async function recreateDatabase(pg, name, { template } = {}) {
	await withAdmin(pg, async (client) => {
		await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
		await client.query(
			`CREATE DATABASE ${quoteIdent(name)}${template ? ` TEMPLATE ${quoteIdent(template)}` : ""}`,
		);
	});
}

export async function dropDatabase(pg, name) {
	await withAdmin(pg, (client) =>
		client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
	);
}
