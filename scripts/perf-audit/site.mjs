/**
 * Builds the perf fixture for production and serves a disposable copy of a
 * seeded database, so nothing a run writes survives into the next run.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeSql } from "../query-counts-normalize.mjs";
import { publishSeed } from "./cache.mjs";
import { startGzipProxy } from "./gzip-proxy.mjs";
import { availablePort } from "./ports.mjs";
import { COUNTS, LONG_POST_SLUG, writeAuditSeed } from "./seed-data.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE_DIR = join(ROOT, "fixtures/perf-site");
const CLI_PATH = join(ROOT, "packages/core/dist/cli/index.mjs");
const ADMIN_DIST = join(ROOT, "packages/admin/dist/index.js");
const BASE_SEED_PATH = join(FIXTURE_DIR, "seed/seed.json");
const CACHE_DIR = join(ROOT, ".perf-audit/seed");
const PROXY_PATH = join(import.meta.dirname, "latency-proxy.mjs");
const HOST = "127.0.0.1";
const QUERY_LOG_PREFIX = "[emdash-query-log] ";
const ADMIN_EMAIL = "perf-audit@emdash.local";
const ADMIN_USER_ID = "perf-audit-admin";
const ENCRYPTION_KEY = "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MEDIA_BASE_URL = "/_emdash/api/media/file";

const FINGERPRINT_PATTERN = /"fingerprint":\s*"([0-9a-f]{64})"/;

const fixtureRequire = createRequire(join(FIXTURE_DIR, "package.json"));
const fixtureImport = (specifier) => import(pathToFileURL(fixtureRequire.resolve(specifier)).href);

const buildDirFor = (db) => join(FIXTURE_DIR, `.perf-audit/dist-${db}`);

export function buildSite({ fonts, db, reactProfile }) {
	if (!existsSync(CLI_PATH) || !existsSync(ADMIN_DIST)) {
		throw new Error("Workspace packages are not built. Run `pnpm build` first.");
	}
	const result = spawnSync(
		join(FIXTURE_DIR, "node_modules/.bin/astro"),
		["build", "--outDir", buildDirFor(db)],
		{
			cwd: FIXTURE_DIR,
			stdio: "pipe",
			encoding: "utf8",
			env: {
				...process.env,
				EMDASH_FIXTURE_TARGET: db,
				EMDASH_REACT_PROFILE: reactProfile ? "1" : "",
				...(fonts ? { EMDASH_FIXTURE_FONTS: "1" } : {}),
			},
		},
	);
	if (result.status !== 0)
		throw new Error(`astro build failed:\n${result.stdout}\n${result.stderr}`);
}

async function openDatabase(kind, url) {
	const { Kysely } = await fixtureImport("kysely");
	const { createDialect } = await fixtureImport(`emdash/db/${kind}`);
	const dialect =
		kind === "sqlite"
			? createDialect({ url })
			: createDialect({ connectionString: url, pool: { max: 4 } });
	return new Kysely({ dialect });
}

function seedCacheKey() {
	const hash = createHash("sha256");
	hash.update(readFileSync(BASE_SEED_PATH));
	hash.update("audit-seed-v2-search");
	hash.update(readFileSync(join(import.meta.dirname, "seed-data.mjs")));
	hash.update(String(statSync(CLI_PATH).size));
	return hash.digest("hex").slice(0, 12);
}

async function addRowsTheSeedFormatCannotExpress(db) {
	await db
		.updateTable("_emdash_collections")
		.set({ search_config: JSON.stringify({ enabled: true, titleField: "title" }) })
		.where("slug", "=", "posts")
		.execute();
	const now = "2026-01-01T00:00:00.000Z";
	const data = JSON.stringify({ welcomeDismissed: true });
	const user = (id, email, name, role) => ({
		id,
		email,
		name,
		role,
		email_verified: 1,
		data,
		created_at: now,
		updated_at: now,
	});
	await db
		.insertInto("users")
		.values([
			user(ADMIN_USER_ID, ADMIN_EMAIL, "Audit Admin", 50),
			...Array.from({ length: COUNTS.users }, (_, index) =>
				user(
					`perf-audit-user-${index}`,
					`user-${index}@emdash.local`,
					`Seeded User ${index}`,
					[10, 20, 30, 40, 50][index % 5],
				),
			),
		])
		.execute();

	const posts = await db.selectFrom("ec_posts").select("id").orderBy("slug").limit(40).execute();
	await db
		.insertInto("_emdash_comments")
		.values(
			Array.from({ length: COUNTS.comments }, (_, index) => ({
				id: `perf-audit-comment-${index}`,
				collection: "posts",
				content_id: posts[index % posts.length].id,
				author_name: `Commenter ${index}`,
				author_email: `commenter-${index}@example.com`,
				body: `Seeded comment number ${index} with a sentence or two of body text to wrap across lines.`,
				status: ["pending", "approved", "spam"][index % 3],
				created_at: now,
				updated_at: now,
			})),
		)
		.execute();

	for (const name of ["emdash:setup_complete", "emdash:seed_complete"]) {
		await db
			.insertInto("options")
			.values({ name, value: "true" })
			.onConflict((conflict) => conflict.column("name").doUpdateSet({ value: "true" }))
			.execute();
	}
}

/** Returns a directory holding a seeded `data.db`, `uploads/` and `seed.json`, built once per seed version. */
export async function ensureSeed({ reseed }) {
	return publishSeed(
		CACHE_DIR,
		`${seedCacheKey()}${reseed ? `-${Date.now()}` : ""}`,
		async (dir) => {
			mkdirSync(join(dir, "uploads"), { recursive: true });
			const seedPath = writeAuditSeed({
				dir,
				uploadsDir: join(dir, "uploads"),
				baseSeedPath: BASE_SEED_PATH,
			});
			const result = spawnSync(
				process.execPath,
				[
					CLI_PATH,
					"seed",
					seedPath,
					"--cwd",
					dir,
					"--database",
					"./data.db",
					"--uploads-dir",
					"./uploads",
				],
				{ cwd: dir, stdio: "pipe", encoding: "utf8" },
			);
			if (result.status !== 0)
				throw new Error(`emdash seed failed:\n${result.stdout}\n${result.stderr}`);
			const db = await openDatabase("sqlite", `file:${join(dir, "data.db")}`);
			await addRowsTheSeedFormatCannotExpress(db);
			await db.destroy();
		},
	);
}

function migratePostgres(url) {
	const run = (...args) =>
		spawnSync(process.execPath, [CLI_PATH, "migrate", "--from-config", "--json", ...args], {
			cwd: FIXTURE_DIR,
			encoding: "utf8",
			env: { ...process.env, EMDASH_FIXTURE_TARGET: "postgres", DATABASE_URL: url },
		});
	const status = run("--status");
	const fingerprint = FINGERPRINT_PATTERN.exec(status.stdout)?.[1];
	if (!fingerprint)
		throw new Error(`emdash migrate --status failed:\n${status.stdout}\n${status.stderr}`);
	const migrated = run("--expected-target-fingerprint", fingerprint);
	if (migrated.status !== 0)
		throw new Error(`emdash migrate failed:\n${migrated.stdout}\n${migrated.stderr}`);
}

/** Seeds a PostgreSQL template database once; each run clones it with CREATE DATABASE. */
export async function ensurePostgresTemplate({ reseed, postgres, seedDir }) {
	const template = `perf_audit_${basename(seedDir)}`;
	const uploadsDir = join(seedDir, "uploads-postgres");
	const readyMarker = join(seedDir, "postgres-ready");
	if (!reseed && existsSync(readyMarker) && (await postgres.exists(template))) return template;
	rmSync(readyMarker, { recursive: true, force: true });

	await postgres.drop(template);
	await postgres.create(template);
	const url = postgres.urlFor(template);

	migratePostgres(url);

	rmSync(uploadsDir, { recursive: true, force: true });
	cpSync(join(seedDir, "uploads/seed"), join(uploadsDir, "seed"), { recursive: true });
	const { applySeed } = await fixtureImport("emdash/seed");
	const { LocalStorage } = await fixtureImport("emdash/storage/local");
	const db = await openDatabase("postgres", url);
	await applySeed(db, JSON.parse(readFileSync(join(seedDir, "seed.json"), "utf8")), {
		includeContent: true,
		onConflict: "skip",
		mediaBasePath: seedDir,
		storage: new LocalStorage({ directory: uploadsDir, baseUrl: MEDIA_BASE_URL }),
	});
	await addRowsTheSeedFormatCannotExpress(db);
	await db.destroy();
	mkdirSync(readyMarker);
	return template;
}

async function waitForTcp(port, child) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error("Server exited before TCP readiness");
		const ready = await new Promise((resolveReady) => {
			const socket = createConnection({ host: HOST, port });
			socket.once("connect", () => {
				socket.destroy();
				resolveReady(true);
			});
			socket.once("error", () => {
				socket.destroy();
				resolveReady(false);
			});
		});
		if (ready) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error("Server TCP port did not open within 60s");
}

/**
 * Inserts a magic-link row so the session comes from the production sign-in
 * route; the dev-bypass endpoints return 403 outside dev builds.
 */
async function createLoginToken(db) {
	const bytes = randomBytes(32);
	await db
		.insertInto("auth_tokens")
		.values({
			hash: createHash("sha256").update(bytes).digest("base64url"),
			user_id: ADMIN_USER_ID,
			email: ADMIN_EMAIL,
			type: "magic_link",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		})
		.execute();
	return bytes.toString("base64url");
}

async function readSeededParams(db) {
	const postId = async (slug) =>
		(
			await db
				.selectFrom("ec_posts")
				.select("id")
				.where("slug", "=", slug)
				.executeTakeFirstOrThrow()
		).id;
	return {
		shortPostId: await postId("generated-post-0"),
		longPostId: await postId(LONG_POST_SLUG),
		productId: (
			await db
				.selectFrom("ec_products")
				.select("id")
				.orderBy("slug")
				.limit(1)
				.executeTakeFirstOrThrow()
		).id,
		sectionSlug: (
			await db
				.selectFrom("_emdash_sections")
				.select("slug")
				.orderBy("slug")
				.limit(1)
				.executeTakeFirstOrThrow()
		).slug,
	};
}

async function startProxy(targetHost, targetPort, latencyMs) {
	const port = await availablePort();
	const child = spawn(
		process.execPath,
		[PROXY_PATH, String(port), targetHost, String(targetPort), String(latencyMs)],
		{
			stdio: ["ignore", "pipe", "inherit"],
		},
	);
	await new Promise((resolveReady, reject) => {
		child.once("exit", () => reject(new Error("Latency proxy exited before listening")));
		child.stdout.once("data", resolveReady);
	});
	return { port, stop: () => child.kill("SIGTERM") };
}

async function preparePostgresRun({ workDir, seedDir, postgres, template, latencyMs }) {
	const database = `perf_audit_run_${Date.now()}_${randomBytes(2).toString("hex")}`;
	await postgres.create(database, template);
	cpSync(join(seedDir, "uploads-postgres"), join(workDir, "uploads"), { recursive: true });
	const url = new URL(postgres.urlFor(database));
	const proxy = latencyMs > 0 ? await startProxy(url.hostname, url.port, latencyMs) : null;
	return {
		dbHandle: await openDatabase("postgres", url.toString()),
		env: {
			PGHOST: url.hostname,
			PGPORT: String(proxy?.port ?? url.port),
			PGDATABASE: database,
			PGUSER: decodeURIComponent(url.username),
			PGPASSWORD: decodeURIComponent(url.password),
			DATABASE_URL: url.toString(),
		},
		async cleanup() {
			proxy?.stop();
			await postgres.drop(database);
		},
	};
}

async function prepareSqliteRun({ workDir, seedDir }) {
	cpSync(join(seedDir, "data.db"), join(workDir, "data.db"));
	cpSync(join(seedDir, "uploads"), join(workDir, "uploads"), { recursive: true });
	return {
		dbHandle: await openDatabase("sqlite", `file:${join(workDir, "data.db")}`),
		env: {},
		async cleanup() {},
	};
}

export async function startSite({
	db,
	seedDir,
	postgres,
	template,
	latencyMs,
	role = "admin",
	gzip = false,
}) {
	const entryPath = join(buildDirFor(db), "server/entry.mjs");
	if (!existsSync(entryPath))
		throw new Error(`No ${db} build found. Run without --skip-build first.`);
	const workDir = mkdtempSync(join(tmpdir(), "emdash-perf-audit-"));
	const run =
		db === "postgres"
			? await preparePostgresRun({ workDir, seedDir, postgres, template, latencyMs })
			: await prepareSqliteRun({ workDir, seedDir });

	await run.dbHandle
		.updateTable("users")
		.set({ role: { admin: 50, editor: 40, author: 30, contributor: 20, subscriber: 10 }[role] })
		.where("id", "=", ADMIN_USER_ID)
		.execute();
	const loginToken = await createLoginToken(run.dbHandle);
	const params = await readSeededParams(run.dbHandle);
	await run.dbHandle.destroy();

	const port = await availablePort();

	const queries = new Map();
	let serverOutput = "";
	let child;
	let readyMs;
	process.once("exit", () => child?.kill());
	const launch = async () => {
		const bootAt = performance.now();
		child = spawn(process.execPath, [entryPath], {
			cwd: workDir,
			env: {
				...process.env,
				...run.env,
				HOST,
				PORT: String(port),
				EMDASH_QUERY_LOG: "1",
				EMDASH_ENCRYPTION_KEY: ENCRYPTION_KEY,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffered = "";
		child.stdout.on("data", (chunk) => {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const index = line.indexOf(QUERY_LOG_PREFIX);
				if (index === -1) continue;
				try {
					const event = JSON.parse(line.slice(index + QUERY_LOG_PREFIX.length));
					if (!queries.has(event.phase)) queries.set(event.phase, []);
					queries.get(event.phase).push({
						sql: normalizeSql(event.sql),
						rawSql: event.sql,
						route: `${event.method} ${event.route}`,
						durationMs: event.durationMs,
						startedAtMs: event.startedAtMs,
						requestId: event.requestId,
					});
				} catch {
					// A truncated line is not a measurement.
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			serverOutput = (serverOutput + chunk).slice(-4000);
		});

		await waitForTcp(port, child);
		readyMs = performance.now() - bootAt;
	};
	await launch();
	const proxy = gzip ? await startGzipProxy(port) : null;
	const baseUrl = `http://${HOST}:${proxy?.port ?? port}`;

	return {
		baseUrl,
		get readyMs() {
			return readyMs;
		},
		async restart() {
			const stopped = new Promise((resolveExit) => child.once("exit", resolveExit));
			child.kill("SIGTERM");
			await stopped;
			await launch();
		},
		loginToken,
		params,
		/** Query events recorded for a measurement id, removed from the buffer. */
		takeQueries(phase) {
			const events = queries.get(phase) ?? [];
			queries.delete(phase);
			return events;
		},
		serverOutput: () => serverOutput,
		async stop() {
			await proxy?.stop();
			child.kill("SIGTERM");
			await Promise.race([
				new Promise((resolveExit) => child.once("exit", resolveExit)),
				new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5000)),
			]);
			await run.cleanup();
			rmSync(workDir, { recursive: true, force: true });
		},
	};
}
