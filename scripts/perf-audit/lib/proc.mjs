import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runningGroups = new Set();
process.on("exit", () => {
	for (const pid of runningGroups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
});

/**
 * Resolve once a TCP connect to host:port succeeds. A TCP probe instead of
 * an HTTP one keeps a fresh workerd isolate cold until the first measured
 * request.
 */
export function waitForPort(port, { host = "127.0.0.1", timeoutMs = 180_000, child } = {}) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolveReady, rejectReady) => {
		const attempt = () => {
			if (child && child.exitCode !== null) {
				rejectReady(new Error(`server exited with code ${child.exitCode} before listening`));
				return;
			}
			if (Date.now() > deadline) {
				rejectReady(new Error(`port ${host}:${port} did not open within ${timeoutMs}ms`));
				return;
			}
			const socket = createConnection({ host, port });
			socket.once("connect", () => {
				socket.destroy();
				resolveReady();
			});
			socket.once("error", () => {
				socket.destroy();
				setTimeout(attempt, 100);
			});
		};
		attempt();
	});
}

export function isPortOpen(port, host = "127.0.0.1") {
	return new Promise((res) => {
		const socket = createConnection({ host, port });
		socket.once("connect", () => {
			socket.destroy();
			res(true);
		});
		socket.once("error", () => {
			socket.destroy();
			res(false);
		});
	});
}

export async function assertPortFree(port) {
	for (let i = 0; i < 50; i++) {
		if (!(await isPortOpen(port))) return;
		await sleep(100);
	}
	throw new Error(
		`Port ${port} is already in use. Stop whatever is listening there (for example a server left from an earlier run) and retry.`,
	);
}

/**
 * Spawn a long-lived process in its own process group so stopping it also
 * stops the children it started (workerd under astro preview), and only
 * those.
 */
export function spawnGroup(cmd, args, { cwd, env, onLine, logStream }) {
	const child = spawn(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	for (const stream of [child.stdout, child.stderr]) {
		const rl = createInterface({ input: stream });
		rl.on("line", (line) => {
			logStream?.write(line + "\n");
			onLine?.(line);
		});
	}
	if (child.pid !== undefined) runningGroups.add(child.pid);
	const exited = new Promise((res) =>
		child.once("exit", (code) => {
			runningGroups.delete(child.pid);
			res(code);
		}),
	);
	async function stop() {
		if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
		const group = -child.pid;
		try {
			process.kill(group, "SIGTERM");
		} catch {
			return;
		}
		const timedOut = await Promise.race([exited.then(() => false), sleep(8_000).then(() => true)]);
		if (timedOut) {
			try {
				process.kill(group, "SIGKILL");
			} catch {
				// already gone
			}
			await exited;
		}
	}
	return { child, stop, exited };
}

export function run(cmd, args, { cwd, env, logStream, allowFailure = false } = {}) {
	const r = spawnSync(cmd, args, {
		cwd,
		env: { ...process.env, ...env },
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	logStream?.write(`$ ${cmd} ${args.join(" ")}\n${r.stdout ?? ""}${r.stderr ?? ""}\n`);
	if (r.status !== 0 && !allowFailure) {
		const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").slice(-30).join("\n");
		throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}):\n${tail}`);
	}
	return r;
}
