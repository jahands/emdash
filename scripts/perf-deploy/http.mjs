import { promises as dns } from "node:dns";
import { request } from "node:https";
import { performance } from "node:perf_hooks";

const RESOLVERS = { A: "resolve4", AAAA: "resolve6", CNAME: "resolveCname" };
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * Look a name up on the zone's authoritative nameservers. Caching resolvers,
 * public or local, would remember the NXDOMAIN from the preflight check for the
 * zone's negative TTL (30 minutes on Cloudflare) and hide the record the custom
 * domain creates.
 */
export async function resolveAuthoritative(name, type, nameServers) {
	const addresses = (await Promise.all(nameServers.map((ns) => dns.resolve4(ns)))).flat();
	const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });
	resolver.setServers(addresses);
	try {
		return await resolver[RESOLVERS[type]](name);
	} catch (error) {
		if (NO_RECORD.has(error?.code)) return [];
		throw error;
	}
}

/**
 * One GET on a fresh TLS connection to `ip`, with SNI and Host set to the URL's
 * hostname. Returns connection and first-byte timings measured from the start
 * of the request.
 */
export function timedGet(url, { ip, headers = {}, timeoutMs = 60_000 } = {}) {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const start = performance.now();
		const timings = {};
		const req = request(
			{
				method: "GET",
				host: target.hostname,
				servername: target.hostname,
				path: `${target.pathname}${target.search}`,
				headers: { "User-Agent": "emdash-perf-deploy", ...headers },
				agent: false,
				lookup: ip
					? (_hostname, options, callback) =>
							options?.all ? callback(null, [{ address: ip, family: 4 }]) : callback(null, ip, 4)
					: undefined,
			},
			(res) => {
				timings.ttfbMs = performance.now() - start;
				let bytes = 0;
				res.on("data", (chunk) => {
					bytes += chunk.length;
				});
				res.on("end", () => {
					const cfRay = res.headers["cf-ray"];
					resolve({
						url: target.toString(),
						status: res.statusCode,
						location: res.headers.location ?? null,
						cfRay: cfRay ?? null,
						colo: typeof cfRay === "string" ? (cfRay.split("-")[1] ?? null) : null,
						bytes,
						connectMs: round(timings.connectMs),
						tlsMs: round(timings.tlsMs),
						ttfbMs: round(timings.ttfbMs),
						serverMs: round(timings.ttfbMs - (timings.tlsMs ?? timings.connectMs ?? 0)),
						totalMs: round(performance.now() - start),
						at: new Date().toISOString(),
					});
				});
				res.on("error", reject);
			},
		);
		req.on("socket", (socket) => {
			socket.once("connect", () => {
				timings.connectMs = performance.now() - start;
			});
			socket.once("secureConnect", () => {
				timings.tlsMs = performance.now() - start;
			});
		});
		req.setTimeout(timeoutMs, () =>
			req.destroy(new Error(`Timed out after ${timeoutMs} ms: ${url}`)),
		);
		req.on("error", reject);
		req.end();
	});
}

function round(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}
