/**
 * Local stand-in for Cloudflare Image Resizing (`/cdn-cgi/image/...`),
 * which `wrangler dev` does not implement. Responses carry
 * `x-perf-audit-emulated: cdn-cgi-image` and results label them emulated.
 *
 * Output dimensions follow the documented `fit`, `width`, `height` and `dpr`
 * semantics (https://developers.cloudflare.com/images/transform-images/transform-via-url/).
 * Encoded bytes come from sharp, not Cloudflare's encoders, and there is no
 * edge cache: each request fetches and transforms the source again, and the
 * browser gets the source's caching headers.
 */

import { loadSharp } from "./deps.mjs";

const PREFIX = "/cdn-cgi/image/";
const ABSOLUTE_SOURCE = /^(https?):\/+(.*)$/;
const OPTION_ALIASES = { w: "width", h: "height", q: "quality", f: "format", g: "gravity" };
const NUMERIC = new Set(["width", "height", "quality", "dpr"]);
const MAX_DPR = 2;
export const DEFAULT_QUALITY = 85;
export const DEFAULT_BACKGROUND = "#ffffff";
const PASSED_THROUGH_HEADERS = ["cache-control", "etag", "last-modified", "expires"];

/** Options the emulator does not apply; results list them when a URL uses one. */
const IGNORED_OPTIONS = new Set([
	"gravity",
	"sharpen",
	"blur",
	"brightness",
	"contrast",
	"gamma",
	"saturation",
	"rotate",
	"flip",
	"trim",
	"zoom",
	"segment",
	"compression",
	"upscale",
]);

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
	if (format === "baseline-jpeg") return "jpeg";
	if (format === "auto") {
		if (accept.includes("image/avif")) return "avif";
		if (accept.includes("image/webp")) return "webp";
	}
	return sourceType.includes("png") ? "png" : "jpeg";
}

const positive = (n) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);

/**
 * Output geometry for a source of `width`x`height` under Cloudflare's
 * options. Returns the output size, the size the source is scaled to before
 * any crop or padding, and how the two relate (`crop`, `pad` or neither).
 *
 * A single dimension scales the other proportionally for every fit.
 */
export function planResize({ width: sw, height: sh }, options = {}) {
	const dpr = Math.min(MAX_DPR, positive(options.dpr) ?? 1);
	const tw = positive(options.width) && Math.round(options.width * dpr);
	const th = positive(options.height) && Math.round(options.height * dpr);
	const fit = options.fit ?? "scale-down";
	const notes = [];
	if (!tw && !th) return { fit, width: sw, height: sh, scaled: { width: sw, height: sh }, notes };

	const size = (scale) => ({
		width: Math.max(1, Math.round(sw * scale)),
		height: Math.max(1, Math.round(sh * scale)),
	});
	const inside = tw && th ? Math.min(tw / sw, th / sh) : tw ? tw / sw : th / sh;
	const outside = tw && th ? Math.max(tw / sw, th / sh) : inside;
	const exact = (scaled) => ({ fit, ...scaled, scaled, notes });
	const cropTo = (scale, width, height) => ({
		fit,
		width,
		height,
		scaled: size(scale),
		crop: true,
		notes,
	});

	switch (fit) {
		case "scale-down":
			return exact(size(Math.min(1, inside)));
		case "contain":
			return exact(size(inside));
		case "scale-up":
			return exact(size(Math.max(1, inside)));
		case "squeeze": {
			const width = tw || Math.round((sw * th) / sh);
			const height = th || Math.round((sh * tw) / sw);
			return { fit, width, height, scaled: { width, height }, notes };
		}
		case "cover": {
			if (!(tw && th)) return exact(size(inside));
			return cropTo(outside, tw, th);
		}
		case "crop": {
			if (!(tw && th)) return exact(size(Math.min(1, inside)));
			if (sw <= tw && sh <= th) return exact({ width: sw, height: sh });
			const scale = Math.min(1, outside);
			const scaled = size(scale);
			return cropTo(scale, Math.min(tw, scaled.width), Math.min(th, scaled.height));
		}
		case "aspect-crop": {
			if (!(tw && th)) return exact(size(Math.min(1, inside)));
			const scale = Math.min(1, outside);
			const scaled = size(scale);
			const ratio = tw / th;
			const width = Math.min(scaled.width, Math.round(scaled.height * ratio));
			const height = Math.min(scaled.height, Math.round(scaled.width / ratio));
			return cropTo(scale, width, height);
		}
		case "pad": {
			const scaled = size(inside);
			if (!(tw && th)) return exact(scaled);
			return { fit, width: tw, height: th, scaled, pad: true, notes };
		}
		default:
			notes.push(`fit=${fit} is not a Cloudflare fit; treated as scale-down`);
			return exact(size(Math.min(1, inside)));
	}
}

/** Options in `options` that the emulator does not apply. */
export function ignoredOptions(options) {
	return Object.keys(options).filter((key) => IGNORED_OPTIONS.has(key));
}

function encode(pipeline, format, options) {
	const quality = positive(options.quality) ?? DEFAULT_QUALITY;
	if (format === "png") return pipeline.png();
	if (format === "jpeg")
		return pipeline.jpeg({ quality, progressive: options.format !== "baseline-jpeg" });
	return pipeline[format]({ quality });
}

export async function resizeImage(buffer, options, accept, sourceType) {
	const sharp = loadSharp();
	const input = sharp(buffer).rotate();
	const meta = await sharp(buffer).metadata();
	const swapped = (meta.orientation ?? 1) >= 5;
	const source = {
		width: swapped ? meta.height : meta.width,
		height: swapped ? meta.width : meta.height,
	};
	const plan = planResize(source, options);
	let pipeline = input;
	if (plan.width !== source.width || plan.height !== source.height || plan.crop || plan.pad) {
		if (plan.crop) {
			pipeline = pipeline.resize({ width: plan.width, height: plan.height, fit: "cover" });
		} else if (plan.pad) {
			pipeline = pipeline.resize({
				width: plan.width,
				height: plan.height,
				fit: "contain",
				background: options.background ?? DEFAULT_BACKGROUND,
			});
		} else {
			pipeline = pipeline.resize({ width: plan.width, height: plan.height, fit: "fill" });
		}
	}
	const format = chooseFormat(options.format, accept, sourceType);
	const body = await encode(pipeline, format, options).toBuffer();
	return {
		body,
		contentType: `image/${format}`,
		width: plan.width,
		height: plan.height,
		ignored: ignoredOptions(options),
	};
}

/**
 * Headers for an emulated response: the source's caching headers, as
 * Cloudflare's transformed variants follow the source's caching rules.
 */
export function responseHeaders(sourceHeaders, contentType) {
	const headers = { "x-perf-audit-emulated": "cdn-cgi-image" };
	if (contentType) headers["content-type"] = contentType;
	for (const name of PASSED_THROUGH_HEADERS) {
		const value = sourceHeaders.get(name);
		if (value) headers[name] = value;
	}
	return headers;
}

/** Serve `/cdn-cgi/image/*` for a browser context. */
export async function installResizeEmulation(context, origin, stats) {
	stats.served ??= 0;
	stats.failed ??= 0;
	stats.revalidated ??= 0;
	stats.outputs ??= {};
	stats.ignoredOptions ??= [];
	await context.route(`${origin}/cdn-cgi/image/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const parsed = parseResizeUrl(url.pathname + url.search, origin);
		if (!parsed) return route.continue();
		const conditional = {};
		const headers = request.headers();
		if (headers["if-none-match"]) conditional["if-none-match"] = headers["if-none-match"];
		if (headers["if-modified-since"])
			conditional["if-modified-since"] = headers["if-modified-since"];
		try {
			const source = await fetch(parsed.source, { headers: conditional });
			if (source.status === 304) {
				stats.revalidated++;
				return route.fulfill({ status: 304, headers: responseHeaders(source.headers, "") });
			}
			if (!source.ok) throw new Error(`source ${source.status}`);
			const input = Buffer.from(await source.arrayBuffer());
			const out = await resizeImage(
				input,
				parsed.options,
				headers.accept ?? "",
				source.headers.get("content-type") ?? "",
			);
			stats.served++;
			stats.outputs[request.url()] = { width: out.width, height: out.height };
			for (const option of out.ignored) {
				if (!stats.ignoredOptions.includes(option)) stats.ignoredOptions.push(option);
			}
			return route.fulfill({
				status: 200,
				body: out.body,
				headers: responseHeaders(source.headers, out.contentType),
			});
		} catch (error) {
			stats.failed++;
			if (parsed.options.onerror === "redirect") {
				return route.fulfill({
					status: 302,
					headers: { location: parsed.source, "x-perf-audit-emulated": "cdn-cgi-image" },
				});
			}
			return route.fulfill({ status: 502, body: String(error) });
		}
	});
}
