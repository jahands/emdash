/**
 * Deterministic owner-style media: photo-like JPEGs and screenshot-like
 * PNGs at camera and display resolutions. The same spec always produces the
 * same bytes, so runs and workspaces upload identical files.
 */

import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSharp } from "./deps.mjs";

export const MEDIA_SPECS = [
	{ name: "harbor-sunrise.jpg", kind: "photo", width: 4000, height: 3000, seed: 1 },
	{ name: "market-portrait.jpg", kind: "photo", width: 3024, height: 4032, seed: 2 },
	{ name: "mountain-trail.jpg", kind: "photo", width: 3600, height: 2400, seed: 3 },
	{ name: "workshop-bench.jpg", kind: "photo", width: 2400, height: 1600, seed: 4 },
	{ name: "city-night.jpg", kind: "photo", width: 3200, height: 2133, seed: 5 },
	{ name: "garden-detail.jpg", kind: "photo", width: 2000, height: 1333, seed: 6 },
	{ name: "coffee-table.jpg", kind: "photo", width: 1800, height: 1200, seed: 7 },
	{ name: "coastline-wide.jpg", kind: "photo", width: 2800, height: 1867, seed: 8 },
	{ name: "dashboard-screenshot.png", kind: "screenshot", width: 2880, height: 1800, seed: 9 },
	{ name: "settings-screenshot.png", kind: "screenshot", width: 1920, height: 1080, seed: 10 },
	{ name: "editor-screenshot.png", kind: "screenshot", width: 2560, height: 1440, seed: 11 },
	{ name: "mobile-screenshot.png", kind: "screenshot", width: 1600, height: 1000, seed: 12 },
];

function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function photo(spec) {
	const sharp = loadSharp();
	const rand = prng(spec.seed);
	const cols = 12;
	const rows = Math.max(2, Math.round((cols * spec.height) / spec.width));
	const coarse = Buffer.alloc(cols * rows * 3);
	for (let i = 0; i < coarse.length; i++) coarse[i] = Math.floor(40 + rand() * 180);
	const base = await sharp(coarse, { raw: { width: cols, height: rows, channels: 3 } })
		.resize(spec.width, spec.height, { kernel: "cubic" })
		.raw()
		.toBuffer();
	for (let i = 0; i < base.length; i++) {
		const grain = (rand() - 0.5) * 40;
		base[i] = Math.max(0, Math.min(255, base[i] + grain));
	}
	return sharp(base, { raw: { width: spec.width, height: spec.height, channels: 3 } })
		.jpeg({ quality: 88 })
		.toBuffer();
}

function fillRect(buf, width, x, y, w, h, [r, g, b]) {
	for (let yy = y; yy < y + h; yy++) {
		for (let xx = x; xx < x + w; xx++) {
			const i = (yy * width + xx) * 3;
			buf[i] = r;
			buf[i + 1] = g;
			buf[i + 2] = b;
		}
	}
}

async function screenshot(spec) {
	const sharp = loadSharp();
	const rand = prng(spec.seed);
	const { width, height } = spec;
	const buf = Buffer.alloc(width * height * 3, 248);
	const sidebar = Math.round(width * 0.16);
	fillRect(buf, width, 0, 0, sidebar, height, [30, 34, 44]);
	fillRect(buf, width, sidebar, 0, width - sidebar, Math.round(height * 0.07), [255, 255, 255]);
	const unit = Math.max(8, Math.round(height / 90));
	for (let y = Math.round(height * 0.1); y < height - unit * 2; y += unit * 2) {
		fillRect(
			buf,
			width,
			unit * 2,
			y,
			Math.round(sidebar * (0.4 + rand() * 0.4)),
			unit,
			[150, 156, 170],
		);
	}
	const contentX = sidebar + unit * 3;
	const contentW = width - contentX - unit * 3;
	const photoW = Math.round(contentW * 0.45);
	const photoH = Math.round(height * 0.5);
	const photoY = Math.round(height * 0.12);
	for (let y = photoY; y < photoY + photoH; y++) {
		for (let x = contentX; x < contentX + photoW; x++) {
			const i = (y * width + x) * 3;
			const v = 90 + ((x * 7 + y * 3) % 80);
			buf[i] = v + rand() * 60;
			buf[i + 1] = v * 0.8 + rand() * 60;
			buf[i + 2] = v * 0.6 + rand() * 60;
		}
	}
	const textX = contentX + photoW + unit * 3;
	for (let y = photoY; y < height - unit * 3; y += Math.round(unit * 1.8)) {
		let x = textX;
		while (x < width - unit * 6) {
			const w = Math.round(unit * (2 + rand() * 6));
			if (x + w > width - unit * 3) break;
			fillRect(buf, width, x, y, w, unit, [60 + rand() * 40, 64, 80]);
			x += w + unit;
		}
	}
	return sharp(buf, { raw: { width, height, channels: 3 } })
		.png({ compressionLevel: 6 })
		.toBuffer();
}

/** Concurrent runs share the cache, so a file appears whole or not at all. */
function writeAtomically(path, bytes) {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, bytes);
	renameSync(temp, path);
}

/** Generate (or reuse from `cacheDir`) every media file. Returns file info. */
export async function generateMedia(cacheDir) {
	mkdirSync(cacheDir, { recursive: true });
	const files = [];
	for (const spec of MEDIA_SPECS) {
		const path = join(cacheDir, spec.name);
		if (!existsSync(path)) {
			writeAtomically(path, spec.kind === "photo" ? await photo(spec) : await screenshot(spec));
		}
		files.push({
			...spec,
			path,
			bytes: statSync(path).size,
			mimeType: spec.kind === "photo" ? "image/jpeg" : "image/png",
		});
	}
	return files;
}

/** A photo that is not in the seeded library, for the upload scenario. */
export async function generateScenarioUpload(cacheDir) {
	mkdirSync(cacheDir, { recursive: true });
	const spec = { name: "scenario-upload.jpg", kind: "photo", width: 2400, height: 1600, seed: 99 };
	const path = join(cacheDir, spec.name);
	if (!existsSync(path)) writeAtomically(path, await photo(spec));
	return path;
}
