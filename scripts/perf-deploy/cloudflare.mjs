import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import {
	assertOwnedDomain,
	assertOwnedName,
	RESOURCE_PREFIX,
	resourceNames,
	zoneCandidates,
} from "./lib.mjs";

const API_BASE = "https://api.cloudflare.com/client/v4";

const children = new Set();

/** Stop every child process this script started (wrangler, astro). */
export function killChildren() {
	for (const child of children) child.kill("SIGTERM");
}

/**
 * Run a command, teeing its output to `logFile`. Resolves with stdout; rejects
 * with the tail of the output on a non-zero exit.
 */
export function runCommand(command, args, { cwd, env, logFile, quiet = false } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);
		const log = logFile ? createWriteStream(logFile, { flags: "a" }) : null;
		log?.write(`\n$ ${command} ${args.join(" ")}\n`);
		let stdout = "";
		let tail = "";
		const onData = (stream) => (chunk) => {
			const text = chunk.toString();
			if (stream === "stdout") stdout += text;
			tail = (tail + text).slice(-4000);
			log?.write(text);
			if (!quiet) process.stderr.write(text);
		};
		child.stdout.on("data", onData("stdout"));
		child.stderr.on("data", onData("stderr"));
		child.on("error", (error) => {
			children.delete(child);
			log?.end();
			reject(error);
		});
		child.on("close", (code, signal) => {
			children.delete(child);
			log?.end();
			if (code === 0) resolve(stdout);
			else reject(new Error(`${command} exited with ${signal ?? code}:\n${tail}`));
		});
	});
}

export class CloudflareApiError extends Error {
	constructor(method, path, status, errors) {
		const detail = (errors ?? []).map((error) => `${error.code}: ${error.message}`).join("; ");
		super(`${method} ${path} -> ${status}${detail ? ` (${detail})` : ""}`);
		this.status = status;
		this.errors = errors ?? [];
	}
}

/**
 * Cloudflare REST client authenticated with wrangler's logged-in credentials.
 * The token stays in memory and is re-read from wrangler (which refreshes an
 * expired OAuth token) when the API answers 401.
 */
export async function createCloudflareClient({ wranglerBin, cwd, accountId }) {
	let token = await readWranglerToken(wranglerBin, cwd);

	async function request(method, path, { body, query, raw = false, retryAuth = true } = {}) {
		const url = new URL(`${API_BASE}${path}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		const init = { method, headers: { Authorization: `Bearer ${token}` } };
		if (body !== undefined) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		const response = await fetch(url, init);
		if (response.status === 401 && retryAuth) {
			token = await readWranglerToken(wranglerBin, cwd);
			return request(method, path, { body, query, raw, retryAuth: false });
		}
		if (raw) return response;
		const json = await response.json().catch(() => ({}));
		if (!response.ok || json.success === false) {
			throw new CloudflareApiError(method, path, response.status, json.errors);
		}
		return json;
	}

	if (!accountId) {
		const { result } = await request("GET", "/accounts", { query: { per_page: 50 } });
		if (result.length !== 1) {
			throw new Error(
				`Wrangler can see ${result.length} accounts; pass --account-id to choose one`,
			);
		}
		accountId = result[0].id;
	}
	const account = `/accounts/${accountId}`;

	const isNotFound = (error) => error instanceof CloudflareApiError && error.status === 404;

	return {
		accountId,
		request,
		isNotFound,

		async findZone(hostname) {
			for (const name of zoneCandidates(hostname)) {
				const { result } = await request("GET", "/zones", {
					query: { name, "account.id": accountId },
				});
				if (result.length > 0) {
					const [zone] = result;
					return { id: zone.id, name: zone.name, nameServers: zone.name_servers };
				}
			}
			return null;
		},

		async listDomains(query = {}) {
			const { result } = await request("GET", `${account}/workers/domains`, { query });
			return result;
		},
		async getDomain(id) {
			return (await request("GET", `${account}/workers/domains/${id}`)).result;
		},
		async attachDomain({ hostname, service, zoneId }) {
			const { result } = await request("PUT", `${account}/workers/domains`, {
				body: { hostname, service, zone_id: zoneId, environment: "production" },
			});
			return result;
		},
		async deleteDomain(id) {
			await request("DELETE", `${account}/workers/domains/${id}`);
		},

		async listScripts() {
			return (await request("GET", `${account}/workers/scripts`)).result;
		},
		async deleteScript(name) {
			await request("DELETE", `${account}/workers/scripts/${name}`, { query: { force: true } });
		},

		async createD1(name) {
			return (await request("POST", `${account}/d1/database`, { body: { name } })).result;
		},
		async getD1(uuid) {
			return (await request("GET", `${account}/d1/database/${uuid}`)).result;
		},
		async listD1(name) {
			return (await request("GET", `${account}/d1/database`, { query: { name, per_page: 100 } }))
				.result;
		},
		async deleteD1(uuid) {
			await request("DELETE", `${account}/d1/database/${uuid}`);
		},

		async createBucket(name) {
			return (await request("POST", `${account}/r2/buckets`, { body: { name } })).result;
		},
		async listBuckets(nameContains) {
			const { result } = await request("GET", `${account}/r2/buckets`, {
				query: { name_contains: nameContains, per_page: 1000 },
			});
			return result.buckets ?? [];
		},
		async listObjects(bucket, cursor) {
			const json = await request("GET", `${account}/r2/buckets/${bucket}/objects`, {
				query: { per_page: 1000, cursor },
			});
			return {
				objects: json.result ?? [],
				cursor: json.result_info?.cursor,
				truncated: json.result_info?.is_truncated,
			};
		},
		async deleteObject(bucket, key) {
			await request(
				"DELETE",
				`${account}/r2/buckets/${bucket}/objects/${key.split("/").map(encodeURIComponent).join("/")}`,
			);
		},
		async deleteBucket(name) {
			await request("DELETE", `${account}/r2/buckets/${name}`);
		},

		async createKv(title) {
			return (await request("POST", `${account}/storage/kv/namespaces`, { body: { title } }))
				.result;
		},
		async getKv(id) {
			return (await request("GET", `${account}/storage/kv/namespaces/${id}`)).result;
		},
		async listKv() {
			const namespaces = [];
			for (let page = 1; ; page++) {
				const json = await request("GET", `${account}/storage/kv/namespaces`, {
					query: { per_page: 100, page },
				});
				namespaces.push(...json.result);
				if (page >= (json.result_info?.total_pages ?? 1)) return namespaces;
			}
		},
		async deleteKv(id) {
			await request("DELETE", `${account}/storage/kv/namespaces/${id}`);
		},
	};
}

async function readWranglerToken(wranglerBin, cwd) {
	const stdout = await runCommand(wranglerBin, ["auth", "token", "--json"], { cwd, quiet: true });
	const { token } = JSON.parse(stdout);
	if (typeof token !== "string" || token.length === 0) {
		throw new Error("wrangler is not logged in; run `wrangler login` first");
	}
	return token;
}

async function step(kind, name, results, fn) {
	try {
		const status = await fn();
		results.push({ kind, name, status });
	} catch (error) {
		results.push({ kind, name, status: "error", error: String(error?.message ?? error) });
	}
}

/**
 * Delete everything recorded in a run's resources file. Every deletion checks
 * that the target carries this run's exact name before it is touched; IDs read
 * from the file are re-fetched and their names compared, so a corrupted file
 * cannot point the teardown at another resource.
 */
export async function teardownRun(cf, record, log = () => {}) {
	const { runId, hostname } = record;
	const names = resourceNames(runId);
	const resources = record.resources ?? {};
	const results = [];

	await step("custom-domain", hostname, results, async () => {
		const candidates = resources.domain?.id
			? [
					await cf.getDomain(resources.domain.id).catch((error) => {
						if (cf.isNotFound(error)) return null;
						throw error;
					}),
				]
			: await cf.listDomains({ hostname });
		const owned = candidates.filter((domain) => domain && domain.service === names.worker);
		if (owned.length === 0) return "absent";
		for (const domain of owned) {
			assertOwnedDomain(domain, { hostname, runId });
			log(`Deleting custom domain ${domain.hostname}`);
			await cf.deleteDomain(domain.id);
		}
		return "deleted";
	});

	await step("worker", names.worker, results, async () => {
		assertOwnedName("Worker", names.worker, runId);
		log(`Deleting Worker ${names.worker}`);
		try {
			await cf.deleteScript(names.worker);
			return "deleted";
		} catch (error) {
			if (cf.isNotFound(error)) return "absent";
			throw error;
		}
	});

	await step("r2", names.r2, results, async () => {
		assertOwnedName("R2 bucket", names.r2, runId);
		const exists = (await cf.listBuckets(names.r2)).some((bucket) => bucket.name === names.r2);
		if (!exists) return "absent";
		let deleted = 0;
		for (;;) {
			const { objects } = await cf.listObjects(names.r2);
			if (objects.length === 0) break;
			for (const object of objects) {
				await cf.deleteObject(names.r2, object.key);
				deleted++;
			}
		}
		log(`Emptied R2 bucket ${names.r2} (${deleted} objects); deleting it`);
		await cf.deleteBucket(names.r2);
		return "deleted";
	});

	await step("d1", names.d1, results, async () => {
		assertOwnedName("D1 database", names.d1, runId);
		const matches = await findOwned(
			resources.d1?.uuid,
			(uuid) => cf.getD1(uuid),
			async () => (await cf.listD1(names.d1)).filter((db) => db.name === names.d1),
			(db) => db.name,
			names.d1,
			cf,
		);
		if (matches.length === 0) return "absent";
		for (const db of matches) {
			log(`Deleting D1 database ${db.name}`);
			await cf.deleteD1(db.uuid);
		}
		return "deleted";
	});

	await step("kv", names.kv, results, async () => {
		assertOwnedName("KV namespace", names.kv, runId);
		const matches = await findOwned(
			resources.kv?.id,
			(id) => cf.getKv(id),
			async () => (await cf.listKv()).filter((ns) => ns.title === names.kv),
			(ns) => ns.title,
			names.kv,
			cf,
		);
		if (matches.length === 0) return "absent";
		for (const ns of matches) {
			log(`Deleting KV namespace ${ns.title}`);
			await cf.deleteKv(ns.id);
		}
		return "deleted";
	});

	return results;
}

async function findOwned(id, getById, listByName, nameOf, expectedName, cf) {
	if (id) {
		try {
			const item = await getById(id);
			if (nameOf(item) !== expectedName) {
				throw new Error(
					`Recorded ID ${id} belongs to "${nameOf(item)}", not "${expectedName}"; not deleting it`,
				);
			}
			return [item];
		} catch (error) {
			if (!cf.isNotFound(error)) throw error;
		}
	}
	return listByName();
}

/** List anything on the account that still carries the run's prefix. */
export async function findLeftovers(cf, { runId, hostname }) {
	const prefix = `${RESOURCE_PREFIX}${runId}`;
	const [scripts, d1, buckets, kv, domains] = await Promise.all([
		cf.listScripts(),
		cf.listD1(prefix),
		cf.listBuckets(prefix),
		cf.listKv(),
		cf.listDomains(),
	]);
	return {
		workers: scripts.map((script) => script.id).filter((name) => name.startsWith(prefix)),
		d1: d1.map((db) => db.name).filter((name) => name.startsWith(prefix)),
		r2: buckets.map((bucket) => bucket.name).filter((name) => name.startsWith(prefix)),
		kv: kv.map((ns) => ns.title).filter((title) => title.startsWith(prefix)),
		customDomains: domains
			.filter((domain) => domain.service?.startsWith(prefix) || domain.hostname === hostname)
			.map((domain) => `${domain.hostname} -> ${domain.service}`),
	};
}
