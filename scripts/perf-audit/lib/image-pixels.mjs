/**
 * The real pixel size of the image a browser selected. `naturalWidth` is
 * divided by the density of a `srcset` width descriptor, so a 2560px file
 * picked for a 1136px slot reports 1136. Fetching the selected URL again
 * and reading the encoded header gives the file's own dimensions.
 */

import { loadSharp } from "./deps.mjs";

const DATA_URL = /^data:[^;,]*(;base64)?,(.*)$/s;

/** Pixel size of encoded image bytes after EXIF orientation; null for vector images. */
export async function decodedSize(buffer) {
	const meta = await loadSharp()(buffer).metadata();
	if (!meta.width || !meta.height || meta.format === "svg") return null;
	const swapped = (meta.orientation ?? 1) >= 5;
	return {
		width: swapped ? meta.height : meta.width,
		height: swapped ? meta.width : meta.height,
	};
}

async function bytesOf(context, url, phase) {
	const data = DATA_URL.exec(url);
	if (data) {
		return Buffer.from(
			data[1] ? data[2] : decodeURIComponent(data[2]),
			data[1] ? "base64" : "utf8",
		);
	}
	if (!url.startsWith("http")) return null;
	const response = await context.request.get(url, {
		headers: { "x-perf-phase": `${phase}:pixels` },
		timeout: 30_000,
	});
	return response.ok() ? response.body() : null;
}

/**
 * Real pixel sizes for `urls`. Emulated `/cdn-cgi/image` responses never
 * reach the server, so their sizes come from the emulator. `cache` is kept
 * across the screens of one profile.
 */
export async function measurePixels(context, urls, { cache, emulated = {}, phase }) {
	const out = new Map();
	for (const url of new Set(urls)) {
		if (emulated[url]) {
			out.set(url, { ...emulated[url], from: "emulator" });
			continue;
		}
		if (!cache.has(url)) {
			let size = null;
			try {
				const bytes = await bytesOf(context, url, phase);
				size = bytes ? await decodedSize(bytes) : null;
			} catch {
				size = null;
			}
			cache.set(url, size && { ...size, from: "decoded" });
		}
		out.set(url, cache.get(url));
	}
	return out;
}
