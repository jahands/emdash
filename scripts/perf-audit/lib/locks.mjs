/**
 * Exclusive files that say who holds a shared resource: a run slot, a
 * results folder, a port. A holder whose process has exited no longer
 * holds anything, so its file is reclaimed.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sleep } from "./proc.mjs";

/**
 * Machine-wide state shared by every checkout's runs. Not `os.tmpdir()`:
 * sandboxes often give each session its own TMPDIR, which would split it.
 */
export const MACHINE_DIR = join(
	process.platform === "win32" ? tmpdir() : "/tmp",
	"emdash-perf-audit",
);

const processToken = randomBytes(6).toString("hex");
const heldByThisProcess = new Set();
process.on("exit", () => {
	for (const file of heldByThisProcess) {
		try {
			unlinkSync(file);
		} catch {
			// already gone
		}
	}
});

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

function readHolder(file) {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Create `file` exclusively. Returns `{ ok: true, release }`, or
 * `{ ok: false, holder }` when a live process holds it. `token` separates
 * holders inside one process.
 */
export function tryHold(file, info = {}, { token = processToken } = {}) {
	mkdirSync(dirname(file), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		let fd;
		try {
			fd = openSync(file, "wx");
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const holder = readHolder(file);
			const mine = holder?.pid === process.pid && holder?.token === token;
			if (holder && (mine || isProcessAlive(holder.pid))) return { ok: false, holder };
			// Stale or unreadable: its process is gone.
			try {
				unlinkSync(file);
			} catch {
				// someone else reclaimed it first
			}
			continue;
		}
		const record = {
			pid: process.pid,
			token,
			command: process.argv.slice(1).join(" "),
			cwd: process.cwd(),
			since: new Date().toISOString(),
			...info,
		};
		writeSync(fd, JSON.stringify(record));
		closeSync(fd);
		heldByThisProcess.add(file);
		const release = () => {
			heldByThisProcess.delete(file);
			const current = readHolder(file);
			if (current?.pid === process.pid && current?.token === token) {
				try {
					unlinkSync(file);
				} catch {
					// already gone
				}
			}
		};
		return { ok: true, release };
	}
	return { ok: false, holder: readHolder(file) };
}

export function describeHolder(holder) {
	if (!holder) return "another process";
	const command = holder.command ? `: ${holder.command.slice(0, 160)}` : "";
	return `pid ${holder.pid} since ${holder.since ?? "?"}${holder.cwd ? ` in ${holder.cwd}` : ""}${command}`;
}

/**
 * Hold `file`, waiting while another process holds it. Says what it is
 * waiting for when the wait starts and every `noticeMs` after that.
 */
export async function acquire(file, { what, log = console.log, pollMs = 1000, noticeMs = 30_000 }) {
	const started = Date.now();
	let lastNotice = 0;
	for (;;) {
		const attempt = tryHold(file, { what });
		if (attempt.ok) {
			if (lastNotice) log(`Got ${what} after ${Math.round((Date.now() - started) / 1000)}s.`);
			return attempt.release;
		}
		const now = Date.now();
		if (!lastNotice) {
			log(`Waiting for ${what}, held by ${describeHolder(attempt.holder)}`);
			lastNotice = now;
		} else if (now - lastNotice >= noticeMs) {
			log(`Still waiting for ${what} (${Math.round((now - started) / 1000)}s so far)`);
			lastNotice = now;
		}
		await sleep(pollMs);
	}
}

/**
 * Register this run machine-wide so runs can say how many others shared
 * the machine while they measured.
 */
export function registerRun(info, dir = join(MACHINE_DIR, "runs")) {
	const file = join(dir, `${process.pid}-${processToken}.json`);
	const held = tryHold(file, info);
	return {
		release: held.ok ? held.release : () => {},
		others() {
			let entries;
			try {
				entries = readdirSync(dir).filter((name) => name.endsWith(".json"));
			} catch {
				return [];
			}
			return entries
				.filter((name) => join(dir, name) !== file)
				.map((name) => readHolder(join(dir, name)))
				.filter((holder) => holder && isProcessAlive(holder.pid));
		},
	};
}
