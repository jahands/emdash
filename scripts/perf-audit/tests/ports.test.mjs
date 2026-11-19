import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquire, tryHold } from "../lib/locks.mjs";
import { candidatePorts, canBind, PortRegistry } from "../lib/ports.mjs";

const NO_FREE_PORTS = /Could not lease 2 free port/;
const WAITING = /^Waiting for the test slot, held by pid \d+/;
const GOT = /^Got the test slot after/;
const range = { first: 20100, last: 20104 };
const freshDir = () => mkdtempSync(join(tmpdir(), "perf-audit-ports-"));

function deadPid() {
	return spawnSync(process.execPath, ["-e", ""]).pid;
}

void test("candidates cover the range once, starting anywhere", () => {
	assert.deepEqual(candidatePorts({ range, start: 20103 }), [20103, 20104, 20100, 20101, 20102]);
	assert.deepEqual(candidatePorts({ range, start: 20100 }), [20100, 20101, 20102, 20103, 20104]);
});

void test("two runs never lease the same port", async () => {
	const dir = freshDir();
	try {
		const opts = { dir, range, bindable: async () => true, random: () => 0 };
		const a = new PortRegistry(opts);
		const b = new PortRegistry(opts);
		const first = await a.allocate(2);
		const second = await b.allocate(2);
		assert.deepEqual(first, [20100, 20101]);
		assert.deepEqual(second, [20102, 20103]);
		await assert.rejects(b.allocate(2), NO_FREE_PORTS);
		assert.equal(await b.claim(20104), true, "a failed allocation releases what it took");
		a.releaseAll();
		assert.equal(await b.claim(20100), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test("ports something else listens on are skipped", async () => {
	const dir = freshDir();
	const server = createServer();
	await new Promise((r) => server.listen(range.first, "127.0.0.1", r));
	try {
		assert.equal(await canBind(range.first), false);
		const registry = new PortRegistry({ dir, range, random: () => 0 });
		const [port] = await registry.allocate(1);
		assert.notEqual(port, range.first);
		assert.equal(readdirSync(dir).length, 1, "the busy port's lease was given back");
		registry.releaseAll();
		assert.equal(readdirSync(dir).length, 0);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

void test("a lease left by a process that exited is reclaimed", async () => {
	const dir = freshDir();
	try {
		writeFileSync(join(dir, "20100.json"), JSON.stringify({ pid: deadPid(), token: "x" }));
		writeFileSync(join(dir, "20101.json"), JSON.stringify({ pid: process.ppid, token: "y" }));
		const registry = new PortRegistry({ dir, range, bindable: async () => true });
		assert.equal(await registry.claim(20100), true);
		assert.equal(await registry.claim(20101), false, "a live holder keeps its port");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

void test("a held lock makes the next holder wait and say why", async () => {
	const dir = freshDir();
	const file = join(dir, "slot.json");
	try {
		const first = tryHold(file, { what: "slot" }, { token: "first" });
		assert.equal(first.ok, true);
		const lines = [];
		let acquired = false;
		const waiting = acquire(file, {
			what: "the test slot",
			log: (l) => lines.push(l),
			pollMs: 20,
		}).then((release) => {
			acquired = true;
			return release;
		});
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(acquired, false);
		assert.match(lines[0], WAITING);
		first.release();
		const release = await waiting;
		assert.match(lines.at(-1), GOT);
		release();
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
