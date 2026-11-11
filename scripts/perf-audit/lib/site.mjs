/**
 * A materialized profile site: build it, run it under its production
 * runtime, read and write its database, and snapshot or restore its state.
 */

import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { loadPg } from "./deps.mjs";
import { startLatencyProxy } from "./latency-proxy.mjs";
import { acquire, MACHINE_DIR } from "./locks.mjs";
import { connectionUrl, dropDatabase, recreateDatabase } from "./postgres.mjs";
import { assertPortFree, run, spawnGroup, waitForPort } from "./proc.mjs";

const QUERY_LOG_PREFIX = "[emdash-query-log] ";
const SELECT_SQL = /^\s*select/i;
const SERVER_ERROR =
	/middleware error|Unhandled|uncaught|RangeError|TypeError|does not exist|ECONNRESET|\[ERROR\]/i;
const PLACEHOLDER = /\?/g;
const STREAM_END_PREFIX = "[emdash-stream-end] ";

export class Site {
	constructor({
		profile,
		siteDir,
		stateDir,
		logDir,
		pg,
		dbLatencyMs,
		label = "primary",
		dbTag = "",
		ports = null,
	}) {
		this.profile = profile;
		this.siteDir = siteDir;
		this.stateDir = stateDir;
		this.logDir = logDir;
		this.pg = pg;
		this.dbLatencyMs = dbLatencyMs;
		// The tag keeps runs from different slots and checkouts apart on a
		// shared EMDASH_TEST_PG server.
		this.dbName = `perf_${dbTag ? `${dbTag}_` : ""}${label === "compare" ? "c_" : ""}${profile.id.replaceAll("-", "_")}`;
		this.ports = ports;
		this.queryEvents = [];
		this.serverErrors = [];
		this.streamEnd = [];
		this.server = null;
		this.proxy = null;
		this.starts = 0;
		this.crashes = 0;
		this.lastStartWaitMs = 0;
		mkdirSync(stateDir, { recursive: true });
		mkdirSync(logDir, { recursive: true });
		this.log = createWriteStream(join(logDir, `${profile.id}.log`), { flags: "a" });
	}

	get origin() {
		return this.profile.origin;
	}

	/** URL the site connects to Postgres through: the latency proxy. */
	get postgresUrl() {
		if (!this.pg) return undefined;
		return connectionUrl(this.pg, {
			host: "127.0.0.1",
			port: this.profile.proxyPort,
			database: this.dbName,
		});
	}

	get directPostgresUrl() {
		return connectionUrl(this.pg, { database: this.dbName });
	}

	astro(args, env = {}) {
		return run(
			process.execPath,
			[join(this.siteDir, "node_modules/astro/bin/astro.mjs"), ...args],
			{
				cwd: this.siteDir,
				env: { ASTRO_TELEMETRY_DISABLED: "1", ...env },
				logStream: this.log,
			},
		);
	}

	build() {
		const started = performance.now();
		this.astro(["build"]);
		return { buildMs: Math.round(performance.now() - started) };
	}

	async resetState() {
		for (const entry of ["data.db", "data.db-wal", "data.db-shm", "uploads", ".wrangler/state"]) {
			rmSync(join(this.siteDir, entry), { recursive: true, force: true });
		}
		rmSync(join(this.siteDir, "node_modules/.astro"), { recursive: true, force: true });
		if (this.profile.usesPostgres) await recreateDatabase(this.pg, this.dbName);
	}

	async startProxy() {
		if (!this.profile.usesPostgres || this.proxy) return;
		await assertPortFree(this.profile.proxyPort);
		this.proxy = startLatencyProxy({
			listenPort: this.profile.proxyPort,
			targetHost: this.pg.host,
			targetPort: this.pg.port,
			latencyMs: this.dbLatencyMs,
		});
		await this.proxy.listening;
	}

	onLine(line) {
		if (SERVER_ERROR.test(line) && !line.includes(QUERY_LOG_PREFIX)) {
			this.serverErrors.push(line.trim().slice(0, 300));
		}
		const q = line.indexOf(QUERY_LOG_PREFIX);
		if (q !== -1) {
			try {
				this.queryEvents.push({
					...JSON.parse(line.slice(q + QUERY_LOG_PREFIX.length)),
					at: performance.now(),
				});
			} catch {
				// partial line
			}
			return;
		}
		const s = line.indexOf(STREAM_END_PREFIX);
		if (s !== -1) {
			try {
				this.streamEnd.push(JSON.parse(line.slice(s + STREAM_END_PREFIX.length)));
			} catch {
				// partial line
			}
		}
	}

	async start() {
		if (this.server) return;
		await this.startProxy();
		await assertPortFree(this.profile.port);
		const env = { EMDASH_QUERY_LOG: "1", ASTRO_TELEMETRY_DISABLED: "1" };
		const onLine = (line) => this.onLine(line);
		this.lastStartWaitMs = 0;
		if (this.profile.runtime === "node") {
			this.server = spawnGroup(process.execPath, ["./dist/server/entry.mjs"], {
				cwd: this.siteDir,
				env: { ...env, HOST: "127.0.0.1", PORT: String(this.profile.port) },
				onLine,
				logStream: this.log,
			});
			this.starts++;
			await waitForPort(this.profile.port, { child: this.server.child });
			return;
		}
		// The Cloudflare Vite plugin takes the first free inspector port from
		// 9229 while it starts, so two starts at once can pick the same one.
		// Starts are short, so runs take turns machine-wide.
		const waitStarted = performance.now();
		const release = await acquire(join(MACHINE_DIR, "workerd-start.json"), {
			what: "another run's workerd start (it picks an inspector port)",
			noticeMs: 15_000,
		});
		this.lastStartWaitMs = performance.now() - waitStarted;
		try {
			this.server = spawnGroup(
				process.execPath,
				[
					join(this.siteDir, "node_modules/astro/bin/astro.mjs"),
					"preview",
					"--host",
					"127.0.0.1",
					"--port",
					String(this.profile.port),
				],
				{
					cwd: this.siteDir,
					env: { ...env, ASTRO_PREVIEW_BACKGROUND: "0", CLOUDFLARE_INCLUDE_PROCESS_ENV: "true" },
					onLine,
					logStream: this.log,
				},
			);
			this.starts++;
			await waitForPort(this.profile.port, { child: this.server.child });
		} finally {
			release();
		}
	}

	/** Restart the server if it exited on its own. Returns true when it had crashed. */
	async ensureRunning() {
		const child = this.server?.child;
		if (!child || (child.exitCode === null && child.signalCode === null)) return false;
		this.server = null;
		this.crashes++;
		await this.start();
		return true;
	}

	async stop() {
		if (!this.server) return;
		await this.server.stop();
		this.server = null;
		await assertPortFree(this.profile.port);
	}

	async close() {
		await this.stop();
		await this.proxy?.close();
		this.proxy = null;
		this.ports?.release([this.profile.port, this.profile.proxyPort].filter(Boolean));
		this.log.end();
	}

	d1File() {
		const dir = join(this.siteDir, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
		if (!existsSync(dir)) return null;
		const file = readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
		return file ? join(dir, file) : null;
	}

	/**
	 * Run SQL against the site's database. `?` placeholders work for every
	 * dialect. Local D1 is a SQLite file owned by workerd, so the server
	 * must be stopped first.
	 */
	async sql(text, params = []) {
		const { database } = this.profile;
		if (database === "postgres" || database === "hyperdrive") {
			const { Client } = loadPg();
			const client = new Client({ connectionString: this.directPostgresUrl });
			await client.connect();
			try {
				let n = 0;
				const result = await client.query(
					text.replace(PLACEHOLDER, () => `$${++n}`),
					params,
				);
				return result.rows;
			} finally {
				await client.end();
			}
		}
		if (database === "d1" && this.server) {
			throw new Error("Stop the workerd server before writing to local D1");
		}
		const file = database === "d1" ? this.d1File() : join(this.siteDir, "data.db");
		if (!file) throw new Error(`No local database for ${this.profile.id}`);
		const db = new DatabaseSync(file);
		try {
			const stmt = db.prepare(text);
			return SELECT_SQL.test(text) ? stmt.all(...params) : (stmt.run(...params), []);
		} finally {
			db.close();
		}
	}

	stateEntries() {
		return this.profile.runtime === "workerd"
			? [".wrangler/state"]
			: ["data.db", "data.db-wal", "data.db-shm", "uploads", "node_modules/.astro"];
	}

	/** Copy the site's state aside. The server must be stopped. */
	async snapshot(name) {
		if (this.server) throw new Error("Stop the server before taking a snapshot");
		const target = join(this.stateDir, "snapshots", name);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });
		for (const entry of this.stateEntries()) {
			const from = join(this.siteDir, entry);
			if (existsSync(from)) cpSync(from, join(target, entry), { recursive: true });
		}
		if (this.profile.usesPostgres) {
			await recreateDatabase(this.pg, `${this.dbName}_${name}`, { template: this.dbName });
		}
	}

	/** Put a snapshot back. The server must be stopped. */
	async restore(name) {
		if (this.server) throw new Error("Stop the server before restoring a snapshot");
		const source = join(this.stateDir, "snapshots", name);
		if (!existsSync(source)) throw new Error(`No snapshot "${name}" for ${this.profile.id}`);
		for (const entry of this.stateEntries()) {
			rmSync(join(this.siteDir, entry), { recursive: true, force: true });
			const from = join(source, entry);
			if (existsSync(from)) cpSync(from, join(this.siteDir, entry), { recursive: true });
		}
		if (this.profile.usesPostgres) {
			await recreateDatabase(this.pg, this.dbName, { template: `${this.dbName}_${name}` });
		}
	}

	async dropDatabases(names) {
		if (!this.profile.usesPostgres) return;
		for (const name of names) await dropDatabase(this.pg, `${this.dbName}_${name}`);
	}
}
