/**
 * Ports for one run. Every checkout on the machine leases ports through the
 * same directory, so concurrent runs never pick the same one, and a port is
 * only leased when nothing is listening on it.
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";

import { MACHINE_DIR, tryHold } from "./locks.mjs";

/** Below Linux's ephemeral range, so outgoing connections never take them. */
export const PORT_RANGE = { first: 15000, last: 15999 };

function listenOnce(port, host) {
	return new Promise((resolve) => {
		const server = createServer();
		server.once("error", (error) =>
			resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"),
		);
		server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
	});
}

/** Whether nothing listens on `port` on either loopback address. */
export async function canBind(port) {
	return (await listenOnce(port, "127.0.0.1")) && (await listenOnce(port, "::1"));
}

/** Every port in `range`, starting at `start` and wrapping around. */
export function candidatePorts({ range = PORT_RANGE, start = range.first }) {
	const size = range.last - range.first + 1;
	const offset = (((start - range.first) % size) + size) % size;
	return Array.from({ length: size }, (_, i) => range.first + ((offset + i) % size));
}

export class PortRegistry {
	constructor({
		dir = join(MACHINE_DIR, "ports"),
		range = PORT_RANGE,
		bindable = canBind,
		random = Math.random,
		owner = "",
	} = {}) {
		this.dir = dir;
		this.range = range;
		this.bindable = bindable;
		this.random = random;
		this.owner = owner;
		this.token = randomBytes(6).toString("hex");
		this.leases = new Map();
	}

	/** Lease exactly `port`. Returns false when it is leased or in use. */
	async claim(port, purpose = "") {
		if (this.leases.has(port)) return false;
		const held = tryHold(
			join(this.dir, `${port}.json`),
			{ owner: this.owner, purpose },
			{ token: this.token },
		);
		if (!held.ok) return false;
		if (!(await this.bindable(port))) {
			held.release();
			return false;
		}
		this.leases.set(port, held.release);
		return true;
	}

	/** Lease `count` free ports. */
	async allocate(count, purpose = "") {
		const size = this.range.last - this.range.first + 1;
		const start = this.range.first + Math.floor(this.random() * size);
		const ports = [];
		for (const port of candidatePorts({ range: this.range, start })) {
			if (ports.length === count) break;
			if (await this.claim(port, purpose)) ports.push(port);
		}
		if (ports.length < count) {
			this.release(ports);
			throw new Error(
				`Could not lease ${count} free port(s) between ${this.range.first} and ${this.range.last}.`,
			);
		}
		return ports;
	}

	release(ports) {
		for (const port of ports) {
			this.leases.get(port)?.();
			this.leases.delete(port);
		}
	}

	releaseAll() {
		this.release([...this.leases.keys()]);
	}
}
