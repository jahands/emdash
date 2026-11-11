/**
 * Local stand-in for Cloudflare Image Resizing (`/cdn-cgi/image/...`),
 * which `wrangler dev` does not implement. Responses carry
 * `x-perf-audit-emulated: cdn-cgi-image` and results label them emulated.
 */

import { loadSharp } from "./deps.mjs";

const PREFIX = "/cdn-cgi/image/";
const ABSOLUTE_SOURCE = /^(https?):\/+(.*)$/;
const OPTION_ALIASES = { w: "width", h: "height", q: "quality", f: "format" };
const NUMERIC = new Set(["width", "height", "quality", "dpr"]);

/**
 * Parse `/cdn-cgi/image/<options>/<source>` into options and a source URL
 * resolved against `origin`. Returns null for other paths.
 */
export function parseResizeUrl(pathAndQuery, origin) {
	if (!pathAndQuery.startsWith(PREFIX)) return null;
	const rest = pathAndQuery.slice(PREFIX.length);
	const slash = rest.indexOf("/");
	if (slash === -1) return null;
	const options = {};
	for (const part of rest.slice(0, slash).split(",")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const rawKey = part.slice(0, eq).trim();
		const key = OPTION_ALIASES[rawKey] ?? rawKey;
		const value = decodeURIComponent(part.slice(eq + 1).trim());
		options[key] = NUMERIC.has(key) ? Number(value) : value;
	}
	let source = rest.slice(slash + 1);
	const absolute = ABSOLUTE_SOURCE.exec(source);
	if (absolute) source = `${absolute[1]}://${absolute[2]}`;
	else source = new URL(source.startsWith("/") ? source : `/${source}`, origin).toString();
	return { options, source };
}

/** Output format for the options and the request's Accept header. */
export function chooseFormat(format, accept = "", sourceType = "image/jpeg") {
	if (format === "avif" || format === "webp" || format === "jpeg" || format === "png")
		return format;
	if (format === "auto") {
		if (accept.includes("image/avif")) return "avif";
		if (accept.includes("image/webp")) return "webp";
	}
	return sourceType.includes("png") ? "png" : "jpeg";
}

export async function resizeImage(buffer, options, accept, sourceType) {
	const sharp = loadSharp();
	const dpr = options.dpr && options.dpr > 0 ? options.dpr : 1;
	const width = options.width ? Math.round(options.width * dpr) : undefined;
	const height = options.height ? Math.round(options.height * dpr) : undefined;
	const fit = options.fit ?? "scale-down";
	const sharpFit =
		fit === "cover" || fit === "crop"
			? "cover"
			: fit === "pad" || fit === "contain"
				? "contain"
				: "inside";
	let pipeline = sharp(buffer);
	if (width || height) {
		pipeline = pipeline.resize({
			width,
			height,
			fit: sharpFit,
			withoutEnlargement: fit === "scale-down" || fit === "crop",
		});
	}
	const format = chooseFormat(options.format, accept, sourceType);
	const quality = options.quality && options.quality > 0 ? options.quality : 85;
	pipeline = format === "png" ? pipeline.png() : pipeline[format]({ quality });
	return { body: await pipeline.toBuffer(), contentType: `image/${format}` };
}

/** Serve `/cdn-cgi/image/*` for a browser context. */
export async function installResizeEmulation(context, origin, stats) {
	await context.route(`${origin}/cdn-cgi/image/**`, async (route) => {
		const url = new URL(route.request().url());
		const parsed = parseResizeUrl(url.pathname + url.search, origin);
		if (!parsed) return route.continue();
		try {
			const source = await fetch(parsed.source);
			if (!source.ok) {
				return route.fulfill({ status: source.status, body: `source ${source.status}` });
			}
			const input = Buffer.from(await source.arrayBuffer());
			const { body, contentType } = await resizeImage(
				input,
				parsed.options,
				route.request().headers().accept ?? "",
				source.headers.get("content-type") ?? "",
			);
			stats.served++;
			return route.fulfill({
				status: 200,
				body,
				headers: {
					"content-type": contentType,
					"cache-control": "public, max-age=31536000",
					"x-perf-audit-emulated": "cdn-cgi-image",
				},
			});
		} catch (error) {
			stats.failed++;
			return route.fulfill({ status: 502, body: String(error) });
		}
	});
}
