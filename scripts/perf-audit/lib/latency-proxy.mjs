/**
 * TCP proxy in front of PostgreSQL that adds round-trip latency and records
 * each query round trip (client message to the server's ReadyForQuery).
 */

import { createConnection, createServer } from "node:net";
import { performance } from "node:perf_hooks";

const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;

/**
 * Incremental parser for the backend side of the PostgreSQL wire protocol.
 * Emits each message's type byte. `expectUnframedByte()` skips the single
 * unframed byte the server sends in reply to an SSL or GSSAPI request.
 */
export function createBackendParser(onMessage) {
	let buffer = Buffer.alloc(0);
	let unframed = 0;
	return {
		expectUnframedByte() {
			unframed++;
		},
		push(chunk) {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			while (true) {
				if (unframed > 0) {
					if (buffer.length < 1) return;
					buffer = buffer.subarray(1);
					unframed--;
					continue;
				}
				if (buffer.length < 5) return;
				const length = buffer.readInt32BE(1);
				if (buffer.length < 1 + length) return;
				onMessage(String.fromCharCode(buffer[0]), buffer.subarray(5, 1 + length));
				buffer = buffer.subarray(1 + length);
			}
		},
	};
}

/** Pull the SQL text out of the first Query or Parse message in a client chunk. */
export function extractSql(chunk) {
	let offset = 0;
	while (offset + 5 <= chunk.length) {
		const type = String.fromCharCode(chunk[offset]);
		const length = chunk.readInt32BE(offset + 1);
		const body = chunk.subarray(offset + 5, Math.min(chunk.length, offset + 1 + length));
		if (type === "Q") {
			const end = body.indexOf(0);
			return body.subarray(0, end === -1 ? undefined : end).toString("utf8");
		}
		if (type === "P") {
			const nameEnd = body.indexOf(0);
			if (nameEnd === -1) return null;
			const queryEnd = body.indexOf(0, nameEnd + 1);
			return body.subarray(nameEnd + 1, queryEnd === -1 ? undefined : queryEnd).toString("utf8");
		}
		if (length < 4) return null;
		offset += 1 + length;
	}
	return null;
}

function delayedWriter(socket, getDelay) {
	let last = 0;
	return (chunk) => {
		const delayMs = getDelay();
		if (delayMs <= 0 && last <= performance.now()) {
			socket.write(chunk);
			return;
		}
		const due = Math.max(performance.now() + delayMs, last);
		last = due;
		setTimeout(
			() => {
				if (!socket.destroyed) socket.write(chunk);
			},
			Math.max(0, due - performance.now()),
		);
	};
}

export function startLatencyProxy({ listenPort, targetHost, targetPort, latencyMs = 0 }) {
	const queries = [];
	const connections = [];
	let oneWay = latencyMs / 2;
	const getDelay = () => oneWay;
	let nextConnection = 0;
	const sockets = new Set();

	const server = createServer((client) => {
		const id = nextConnection++;
		const connection = { id, openedAt: performance.now(), readyAt: null };
		connections.push(connection);
		const upstream = createConnection({ host: targetHost, port: targetPort });
		sockets.add(client);
		sockets.add(upstream);
		const toServer = delayedWriter(upstream, getDelay);
		const toClient = delayedWriter(client, getDelay);
		let firstClientChunk = true;
		let inFlight = null;

		const parser = createBackendParser((type) => {
			if (type !== "Z") return;
			const now = performance.now() + oneWay;
			if (connection.readyAt === null) {
				connection.readyAt = now;
				return;
			}
			if (inFlight) {
				queries.push({ ...inFlight, end: now, connection: id });
				inFlight = null;
			}
		});

		client.on("data", (chunk) => {
			if (firstClientChunk) {
				firstClientChunk = false;
				if (chunk.length >= 8) {
					const code = chunk.readInt32BE(4);
					if (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE) {
						parser.expectUnframedByte();
						firstClientChunk = true;
					}
				}
			} else if (connection.readyAt !== null && !inFlight && chunk[0] !== 0x58) {
				inFlight = { start: performance.now(), sql: extractSql(chunk) };
			}
			toServer(chunk);
		});
		upstream.on("data", (chunk) => {
			parser.push(chunk);
			toClient(chunk);
		});
		const close = () => {
			client.destroy();
			upstream.destroy();
			sockets.delete(client);
			sockets.delete(upstream);
		};
		client.on("error", close);
		upstream.on("error", close);
		client.on("close", () => setTimeout(() => upstream.end(), oneWay));
		upstream.on("close", () => setTimeout(() => client.end(), oneWay));
	});

	const listening = new Promise((res, rej) => {
		server.once("error", rej);
		server.listen(listenPort, "127.0.0.1", () => res());
	});

	return {
		listening,
		address: () => server.address(),
		setLatency(ms) {
			oneWay = ms / 2;
		},
		/** Query and connection records from `since` (a performance.now() value) on. */
		window(since, until = performance.now()) {
			return {
				queries: queries.filter((q) => q.start >= since && q.end <= until + oneWay * 2),
				connections: connections.filter((c) => c.openedAt >= since && c.openedAt <= until),
			};
		},
		close: () =>
			new Promise((res) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => res());
			}),
	};
}
