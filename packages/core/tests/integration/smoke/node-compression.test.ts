import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import http from "node:http";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureBuilt } from "../server.js";

const execAsync = promisify(execFile);
const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../../..");
const FIXTURE_DIR = resolve(import.meta.dirname, "../fixture");
const SERVERS_BASE = resolve(import.meta.dirname, "../.servers");
const DONOR_NODE_MODULES = resolve(WORKSPACE_ROOT, "demos/simple/node_modules");
const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");
const SMOKE_FONT_PROVIDER_IMPORT = pathToFileURL(
	resolve(import.meta.dirname, "smoke-font-provider.mjs"),
).href;
const PORT = 4497;

interface Head {
	status: number;
	headers: http.IncomingHttpHeaders;
}

function get(path: string, acceptEncoding: string): Promise<Head> {
	return new Promise((resolvePromise, reject) => {
		http
			.get(
				`http://127.0.0.1:${PORT}${path}`,
				{ headers: { "accept-encoding": acceptEncoding } },
				(res) => {
					res.resume();
					res.on("end", () =>
						resolvePromise({ status: res.statusCode ?? 0, headers: res.headers }),
					);
				},
			)
			.on("error", reject);
	});
}

async function waitForServer(): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		try {
			await get("/", "identity");
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	throw new Error("standalone server did not start");
}

describe("Node standalone compression", () => {
	let workDir: string;
	let server: ChildProcess | undefined;
	let script: string;

	beforeAll(async () => {
		await ensureBuilt();
		mkdirSync(SERVERS_BASE, { recursive: true });
		workDir = mkdtempSync(join(SERVERS_BASE, "compression-"));
		cpSync(FIXTURE_DIR, workDir, {
			recursive: true,
			filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
		});
		symlinkSync(DONOR_NODE_MODULES, join(workDir, "node_modules"));

		const databasePath = join(workDir, "compression.db");
		const env = {
			...process.env,
			CI: "true",
			NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${SMOKE_FONT_PROVIDER_IMPORT}`]
				.filter(Boolean)
				.join(" "),
			EMDASH_TEST_DB: `file:${databasePath}`,
			EMDASH_TEST_UPLOADS: join(workDir, "uploads"),
			EMDASH_TEST_VITE_CACHE: join(workDir, ".vite-cache"),
		};
		await execAsync(process.execPath, [
			CLI_BIN,
			"init",
			"--database",
			databasePath,
			"--cwd",
			workDir,
		]);
		await execAsync(process.execPath, [
			CLI_BIN,
			"seed",
			"--database",
			databasePath,
			"--cwd",
			workDir,
		]);
		await execAsync(join(workDir, "node_modules", ".bin", "astro"), ["build"], {
			cwd: workDir,
			timeout: 150_000,
			env,
		});

		const assets = readdirSync(join(workDir, "dist/client/_astro"));
		script = assets.find((name) => name.endsWith(".js") && assets.includes(`${name}.br`)) ?? "";

		server = spawn(process.execPath, ["dist/server/entry.mjs"], {
			cwd: workDir,
			env: {
				...env,
				NODE_OPTIONS: process.env.NODE_OPTIONS,
				HOST: "127.0.0.1",
				PORT: String(PORT),
			},
			stdio: "ignore",
		});
		await waitForServer();
	}, 240_000);

	afterAll(() => {
		server?.kill();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("serves the build's precompressed scripts", async () => {
		expect(script).not.toBe("");

		const br = await get(`/_astro/${script}`, "gzip, deflate, br");
		expect(br.headers["content-encoding"]).toBe("br");
		expect(br.headers.vary).toBe("Accept-Encoding");

		const gzip = await get(`/_astro/${script}`, "gzip");
		expect(gzip.headers["content-encoding"]).toBe("gzip");

		const identity = await get(`/_astro/${script}`, "identity");
		expect(identity.headers["content-encoding"]).toBeUndefined();
	});

	it("compresses rendered pages and API responses", async () => {
		const page = await get("/", "gzip, deflate, br");
		expect(page.headers["content-type"]).toContain("text/html");
		expect(page.headers["content-encoding"]).toBe("br");

		const api = await get("/_emdash/api/manifest", "gzip");
		expect(api.headers["content-type"]).toContain("application/json");
		expect(api.headers["content-encoding"]).toBe("gzip");
	});
});
