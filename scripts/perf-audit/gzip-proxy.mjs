import { createServer, request } from "node:http";
import { pipeline } from "node:stream";
import { createGzip } from "node:zlib";

const COMPRESSIBLE = /(?:javascript|json|text\/|image\/svg\+xml)/i;
const ignoreDisconnect = () => {};

export async function startGzipProxy(port) {
	const server = createServer((incoming, outgoing) => {
		const upstream = request(
			{
				hostname: "127.0.0.1",
				port,
				path: incoming.url,
				method: incoming.method,
				headers: { ...incoming.headers, "accept-encoding": "identity" },
			},
			(response) => {
				const headers = { ...response.headers };
				const acceptsGzip = (incoming.headers["accept-encoding"] ?? "").split(",").some((entry) => {
					const [coding, ...parameters] = entry.trim().split(";");
					const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
					return coding === "gzip" && (!quality || Number(quality.trim().slice(2)) > 0);
				});
				const compressible =
					!headers["content-encoding"] && COMPRESSIBLE.test(String(headers["content-type"] ?? ""));
				if (compressible)
					headers.vary = [headers.vary, "Accept-Encoding"].filter(Boolean).join(", ");
				const gzip =
					compressible &&
					acceptsGzip &&
					incoming.method !== "HEAD" &&
					![204, 304].includes(response.statusCode);
				if (gzip) {
					delete headers["content-length"];
					headers["content-encoding"] = "gzip";
					if (headers.etag && !headers.etag.startsWith("W/")) headers.etag = `W/${headers.etag}`;
				}
				outgoing.writeHead(response.statusCode, headers);
				if (gzip) pipeline(response, createGzip(), outgoing, ignoreDisconnect);
				else pipeline(response, outgoing, ignoreDisconnect);
			},
		);
		upstream.on("error", () => {
			if (!outgoing.headersSent) outgoing.writeHead(502);
			outgoing.end();
		});
		pipeline(incoming, upstream, ignoreDisconnect);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		port: server.address().port,
		stop: () => new Promise((resolve) => server.close(resolve)),
	};
}
