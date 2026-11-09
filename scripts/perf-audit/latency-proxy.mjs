#!/usr/bin/env node
/**
 * TCP proxy adding a fixed round-trip delay between the app and PostgreSQL.
 * Runs in its own process so the audit's browser work can't delay its timers.
 *
 * Usage: latency-proxy.mjs <listenPort> <targetHost> <targetPort> <roundTripMs>
 */

import { createConnection, createServer } from "node:net";

const [listenPort, targetHost, targetPort, roundTripMs] = process.argv.slice(2);
const oneWayMs = Number(roundTripMs) / 2;

function pipeDelayed(from, to) {
	from.on("data", (chunk) => {
		setTimeout(() => {
			if (!to.destroyed) to.write(chunk);
		}, oneWayMs);
	});
	from.on("end", () => setTimeout(() => to.end(), oneWayMs));
	from.on("error", () => to.destroy());
	from.on("close", () => setTimeout(() => to.destroy(), oneWayMs));
}

const server = createServer((client) => {
	client.setNoDelay(true);
	const upstream = createConnection({ host: targetHost, port: Number(targetPort) });
	upstream.setNoDelay(true);
	pipeDelayed(client, upstream);
	pipeDelayed(upstream, client);
});

server.listen(Number(listenPort), "127.0.0.1", () => process.stdout.write("ready\n"));
