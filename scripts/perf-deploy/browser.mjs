import { chromium } from "@playwright/test";

import { classifyImageUrl } from "./lib.mjs";
import { MAX_UPLOAD_BYTES, MEDIA_SPECS, MIN_UPLOAD_BYTES } from "./media-specs.mjs";

export const VIEWPORTS = {
	desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
	mobile: {
		viewport: { width: 390, height: 844 },
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true,
	},
};

const ADMIN_DASHBOARD_URL = /\/_emdash\/admin\/?$/;
const API_HEADERS = { "X-EmDash-Request": "1" };

export async function launchBrowser({ hostname, ip }) {
	return chromium.launch({
		args: [`--host-resolver-rules=MAP ${hostname} ${ip}`],
	});
}

/** Call the EmDash API from the page, so the request carries the browser's session. */
async function api(page, method, path, body) {
	const result = await page.evaluate(
		async (call) => {
			const init = { method: call.method, headers: { ...call.headers } };
			if (call.body !== undefined) {
				init.headers["Content-Type"] = "application/json";
				init.body = JSON.stringify(call.body);
			}
			const response = await fetch(call.path, init);
			return { status: response.status, json: await response.json().catch(() => null) };
		},
		{ method, path, body, headers: API_HEADERS },
	);
	if (result.status >= 400) {
		throw new Error(
			`${method} ${path} -> ${result.status}: ${JSON.stringify(result.json?.error ?? result.json)}`,
		);
	}
	return result.json?.data;
}

/**
 * Complete the setup wizard as a new owner would, registering a passkey with a
 * Chrome DevTools virtual authenticator. Returns the signed-in storage state.
 */
export async function completeSetup(browser, { origin, email, siteTitle }) {
	const context = await browser.newContext({ ...VIEWPORTS.desktop, locale: "en-US" });
	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport: "internal",
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});

	const timeout = 120_000;
	await page.goto(`${origin}/_emdash/admin/setup`, { timeout });
	await page.getByLabel("Site Title").fill(siteTitle, { timeout });
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByText("Create your account").waitFor({ timeout: 300_000 });
	await page.getByLabel("Your Email").fill(email);
	await page.getByLabel("Your Name").fill("Perf Check Owner");
	await page.getByRole("button", { name: "Continue" }).click();
	await page.getByRole("button", { name: "Create passkey" }).click({ timeout });
	await page.getByRole("button", { name: "Open the dashboard" }).click({ timeout });
	await page.waitForURL(ADMIN_DASHBOARD_URL, { timeout });

	const me = await api(page, "GET", "/_emdash/api/auth/me");
	const storageState = await context.storageState();
	return { context, page, storageState, user: me };
}

/**
 * Runs inside the page: draws a deterministic photo-like or screenshot-like
 * image, encodes it within the byte limits, and uploads it through the media
 * API the way the admin does (file, dimensions and a 64px thumbnail).
 */
async function generateAndUpload({ spec, minBytes, maxBytes, headers }) {
	const rand = (() => {
		let a = spec.seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	})();
	const { width, height } = spec;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	const hue = Math.floor(rand() * 360);

	const addNoise = (x, y, w, h, amount) => {
		const data = ctx.getImageData(x, y, w, h);
		const px = data.data;
		for (let i = 0; i < px.length; i += 4) {
			const n = (rand() - 0.5) * amount;
			px[i] = px[i] + n + (rand() - 0.5) * amount * 0.4;
			px[i + 1] = px[i + 1] + n;
			px[i + 2] = px[i + 2] + n + (rand() - 0.5) * amount * 0.4;
		}
		ctx.putImageData(data, x, y);
	};

	const drawLandscape = (x, y, w, h) => {
		const sky = ctx.createLinearGradient(0, y, 0, y + h * 0.7);
		sky.addColorStop(0, `hsl(${hue}, 55%, 35%)`);
		sky.addColorStop(1, `hsl(${(hue + 40) % 360}, 70%, 78%)`);
		ctx.fillStyle = sky;
		ctx.fillRect(x, y, w, h);
		const sunX = x + w * (0.2 + rand() * 0.6);
		const sunY = y + h * (0.15 + rand() * 0.25);
		const sun = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.35);
		sun.addColorStop(0, "rgba(255, 245, 220, 0.95)");
		sun.addColorStop(1, "rgba(255, 245, 220, 0)");
		ctx.fillStyle = sun;
		ctx.fillRect(x, y, w, h);
		for (let layer = 0; layer < 5; layer++) {
			const base = y + h * (0.45 + layer * 0.11);
			const amp = h * (0.12 - layer * 0.015);
			const f1 = 1 + rand() * 3;
			const f2 = 4 + rand() * 9;
			const p1 = rand() * 6.28;
			const p2 = rand() * 6.28;
			ctx.beginPath();
			ctx.moveTo(x, y + h);
			for (let px = 0; px <= w; px += Math.max(2, Math.floor(w / 800))) {
				const t = px / w;
				const ridge =
					Math.sin(t * f1 * 6.28 + p1) * amp +
					Math.sin(t * f2 * 6.28 + p2) * amp * 0.3 +
					(rand() - 0.5) * amp * 0.08;
				ctx.lineTo(x + px, base - ridge);
			}
			ctx.lineTo(x + w, y + h);
			ctx.closePath();
			const light = 55 - layer * 9;
			const fill = ctx.createLinearGradient(0, base - amp, 0, y + h);
			fill.addColorStop(0, `hsl(${(hue + 160 + layer * 12) % 360}, 30%, ${light}%)`);
			fill.addColorStop(1, `hsl(${(hue + 180 + layer * 12) % 360}, 35%, ${light - 15}%)`);
			ctx.fillStyle = fill;
			ctx.fill();
		}
		const blades = Math.floor((w * h) / 400);
		ctx.lineWidth = Math.max(1, w / 1600);
		for (let i = 0; i < blades; i++) {
			const bx = x + rand() * w;
			const by = y + h * (0.75 + rand() * 0.25);
			ctx.strokeStyle = `hsla(${(hue + 100 + rand() * 40) % 360}, 45%, ${15 + rand() * 35}%, 0.7)`;
			ctx.beginPath();
			ctx.moveTo(bx, by);
			ctx.lineTo(bx + (rand() - 0.5) * w * 0.004, by - rand() * h * 0.03);
			ctx.stroke();
		}
	};

	const words = [
		"Overview",
		"Revenue",
		"Sessions",
		"Pages",
		"Media",
		"Settings",
		"Members",
		"Publish",
		"Draft",
		"Review",
		"Scheduled",
		"Archive",
		"Analytics",
		"Traffic",
		"Storage",
		"Billing",
		"Account",
		"Updated",
		"Status",
		"Owner",
	];
	const word = () => words[Math.floor(rand() * words.length)];

	const drawScreenshot = (photoRegions) => {
		const s = width / 1440;
		ctx.fillStyle = "#f5f6f8";
		ctx.fillRect(0, 0, width, height);
		ctx.fillStyle = `hsl(${hue}, 25%, 18%)`;
		ctx.fillRect(0, 0, width, 56 * s);
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 56 * s, 240 * s, height);
		ctx.font = `${14 * s}px sans-serif`;
		for (let i = 0; i < 14; i++) {
			ctx.fillStyle = i === 2 ? `hsl(${hue}, 70%, 45%)` : "#3b4252";
			ctx.fillText(`${word()} ${word().toLowerCase()}`, 28 * s, (100 + i * 36) * s);
		}
		ctx.fillStyle = "#e6f0ff";
		ctx.font = `${16 * s}px sans-serif`;
		ctx.fillText(`${word()} / ${word()} / ${word()}`, 260 * s, 34 * s);
		const cols = 3;
		const cardW = (width - 280 * s - (cols - 1) * 20 * s) / cols;
		for (let c = 0; c < cols; c++) {
			const cx = 260 * s + c * (cardW + 20 * s);
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(cx, 80 * s, cardW, 120 * s);
			ctx.fillStyle = "#6b7280";
			ctx.font = `${13 * s}px sans-serif`;
			ctx.fillText(word(), cx + 16 * s, 108 * s);
			ctx.fillStyle = "#111827";
			ctx.font = `bold ${30 * s}px sans-serif`;
			ctx.fillText(Math.floor(rand() * 90000 + 1000).toLocaleString("en-US"), cx + 16 * s, 152 * s);
		}
		const chartX = 260 * s;
		const chartY = 220 * s;
		const chartW = width - 280 * s;
		const chartH = 300 * s;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(chartX, chartY, chartW, chartH);
		ctx.strokeStyle = "#e5e7eb";
		ctx.lineWidth = s;
		for (let g = 1; g < 6; g++) {
			ctx.beginPath();
			ctx.moveTo(chartX, chartY + (g * chartH) / 6);
			ctx.lineTo(chartX + chartW, chartY + (g * chartH) / 6);
			ctx.stroke();
		}
		for (let series = 0; series < 3; series++) {
			ctx.beginPath();
			let v = 0.5;
			for (let i = 0; i <= 120; i++) {
				v = Math.min(0.95, Math.max(0.05, v + (rand() - 0.5) * 0.12));
				const px = chartX + (i / 120) * chartW;
				const py = chartY + chartH * (1 - v);
				if (i === 0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			}
			ctx.strokeStyle = `hsl(${(hue + series * 110) % 360}, 65%, 50%)`;
			ctx.lineWidth = 2.5 * s;
			ctx.stroke();
		}
		const tableY = chartY + chartH + 20 * s;
		ctx.font = `${13 * s}px sans-serif`;
		for (let row = 0; tableY + row * 34 * s < height - 20 * s; row++) {
			ctx.fillStyle = row % 2 ? "#ffffff" : "#fafafa";
			ctx.fillRect(chartX, tableY + row * 34 * s, chartW, 34 * s);
			ctx.fillStyle = "#374151";
			for (let col = 0; col < 6; col++) {
				ctx.fillText(
					col === 0 ? `${word()} ${word().toLowerCase()} ${Math.floor(rand() * 999)}` : word(),
					chartX + 16 * s + col * (chartW / 6),
					tableY + row * 34 * s + 22 * s,
				);
			}
		}
		for (let i = 0; i < photoRegions; i++) {
			const pw = Math.floor(260 * s);
			const ph = Math.floor(170 * s);
			const px = Math.floor(width - pw - 30 * s - (i % 3) * (pw + 16 * s));
			const py = Math.floor(tableY + 20 * s + Math.floor(i / 3) * (ph + 16 * s));
			if (px < 0 || py + ph > height) continue;
			drawLandscape(px, py, pw, ph);
			addNoise(px, py, pw, ph, 28);
		}
	};

	const toBlob = (type, quality) =>
		new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));

	let blob;
	let quality = null;
	let photoRegions = 0;
	if (spec.kind === "photo") {
		drawLandscape(0, 0, width, height);
		addNoise(0, 0, width, height, 22);
		for (const q of [0.92, 0.86, 0.8, 0.72, 0.64, 0.56, 0.48]) {
			blob = await toBlob("image/jpeg", q);
			quality = q;
			if (blob.size <= maxBytes) break;
		}
	} else {
		for (photoRegions = 0; photoRegions <= 9; photoRegions += 3) {
			drawScreenshot(photoRegions);
			blob = await toBlob("image/png");
			if (blob.size >= minBytes) break;
		}
	}

	const thumbScale = Math.min(1, 64 / Math.max(width, height));
	const thumbCanvas = document.createElement("canvas");
	thumbCanvas.width = Math.max(1, Math.round(width * thumbScale));
	thumbCanvas.height = Math.max(1, Math.round(height * thumbScale));
	thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
	const thumbnail = await new Promise((resolve) => thumbCanvas.toBlob(resolve, "image/png"));

	const bytes = new Uint8Array(await blob.arrayBuffer());
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	const sha256 = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");

	const form = new FormData();
	form.append("file", new File([blob], spec.filename, { type: blob.type }));
	form.append("width", String(width));
	form.append("height", String(height));
	form.append("thumbnail", thumbnail, "thumbnail.png");
	form.append("alt", spec.alt);
	const started = performance.now();
	const response = await fetch("/_emdash/api/media", { method: "POST", body: form, headers });
	const json = await response.json().catch(() => null);
	return {
		status: response.status,
		item: json?.data?.item ?? null,
		error: json?.error ?? null,
		bytes: blob.size,
		mimeType: blob.type,
		sha256,
		quality,
		photoRegions,
		uploadMs: Math.round(performance.now() - started),
	};
}

export async function uploadMedia(page, log) {
	const uploads = [];
	for (const spec of MEDIA_SPECS) {
		const result = await page.evaluate(generateAndUpload, {
			spec,
			minBytes: MIN_UPLOAD_BYTES,
			maxBytes: MAX_UPLOAD_BYTES,
			headers: API_HEADERS,
		});
		if (result.status !== 201 || !result.item) {
			throw new Error(
				`Uploading ${spec.filename} failed with ${result.status}: ${JSON.stringify(result.error)}`,
			);
		}
		log(
			`Uploaded ${spec.filename} ${spec.width}×${spec.height} ` +
				`${(result.bytes / 1024 / 1024).toFixed(2)} MB in ${result.uploadMs} ms`,
		);
		uploads.push({ ...spec, ...result });
	}
	return uploads;
}

function imageFieldValue(item) {
	return {
		id: item.id,
		provider: "local",
		alt: item.alt ?? "",
		width: item.width,
		height: item.height,
		filename: item.filename,
		mimeType: item.mimeType,
		blurhash: item.blurhash ?? undefined,
		dominantColor: item.dominantColor ?? undefined,
		meta: { storageKey: item.storageKey },
	};
}

function imageBlock(item, key) {
	return {
		_type: "image",
		_key: key,
		asset: { _ref: item.id, url: item.url },
		alt: item.alt ?? undefined,
		width: item.width,
		height: item.height,
		...(item.blurhash ? { blurhash: item.blurhash } : {}),
		...(item.dominantColor ? { dominantColor: item.dominantColor } : {}),
	};
}

/**
 * Give every post an uploaded featured image and put photos and screenshots in
 * the bodies of the two newest posts, then publish them.
 */
export async function seedContent(page, uploads, log) {
	const items = uploads.map((upload) => upload.item);
	const photos = items.filter((item) => item.mimeType === "image/jpeg");
	const screenshots = items.filter((item) => item.mimeType === "image/png");
	const list = await api(page, "GET", "/_emdash/api/content/posts?limit=100");
	const posts = list.items
		.filter((post) => post.status === "published")
		.toSorted((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
	if (posts.length < 2)
		throw new Error(`Expected the template's sample posts, found ${posts.length}`);

	const edited = [];
	for (const [index, summary] of posts.entries()) {
		const { item, _rev } = await api(page, "GET", `/_emdash/api/content/posts/${summary.id}`);
		const featured =
			index % 4 === 3 ? screenshots[index % screenshots.length] : photos[index % photos.length];
		const data = { featured_image: imageFieldValue(featured) };
		if (index < 2) {
			const content = Array.isArray(item.data.content) ? [...item.data.content] : [];
			content.splice(1, 0, imageBlock(photos[(index + 1) % photos.length], `perf-photo-${index}`));
			content.splice(
				Math.min(4, content.length),
				0,
				imageBlock(screenshots[index % screenshots.length], `perf-shot-${index}`),
			);
			data.content = content;
		}
		await api(page, "PUT", `/_emdash/api/content/posts/${item.id}`, { data, _rev });
		await api(page, "POST", `/_emdash/api/content/posts/${item.id}/publish`, {});
		edited.push({
			id: item.id,
			slug: item.slug,
			bodyImages: index < 2 ? 2 : 0,
			featured: featured.filename,
		});
	}
	log(`Updated and published ${edited.length} posts`);
	return { posts: edited, newest: edited[0] };
}

/**
 * Runs in the page: every image currently intersecting the viewport. For an
 * image picked from `srcset`, `naturalWidth` is divided by the candidate's
 * density, so the pixel size comes from a plain `Image` of `currentSrc`, which
 * the browser serves from its memory cache.
 */
async function collectVisibleImages() {
	const out = [];
	for (const [index, img] of [...document.images].entries()) {
		const rect = img.getBoundingClientRect();
		if (!(rect.bottom > 0 && rect.top < innerHeight && rect.width > 0 && rect.height > 0)) continue;
		if (!img.dataset.perfId) img.dataset.perfId = String(index);
		const url = img.currentSrc || img.src;
		const probe = new Image();
		probe.src = url;
		await probe.decode().catch(() => {});
		out.push({
			id: img.dataset.perfId,
			url,
			naturalWidth: probe.naturalWidth,
			naturalHeight: probe.naturalHeight,
			densityCorrectedWidth: img.naturalWidth,
			renderedWidth: Math.round(rect.width * 10) / 10,
			renderedHeight: Math.round(rect.height * 10) / 10,
			objectFit: getComputedStyle(img).objectFit,
			loading: img.loading,
			sizes: img.sizes || null,
			srcsetCandidates: img.srcset ? img.srcset.split(",").length : 0,
			alt: img.alt,
		});
	}
	return out;
}

/**
 * Runs in the page: scroll the main scroll container (the document, or the
 * largest scrollable element, as in the admin) down by most of a screen.
 * Returns false once it is at the bottom.
 */
function scrollOneScreen() {
	let target = document.scrollingElement;
	let room = target.scrollHeight - target.clientHeight - target.scrollTop;
	for (const element of document.querySelectorAll("*")) {
		const overflowY = getComputedStyle(element).overflowY;
		if (overflowY !== "auto" && overflowY !== "scroll") continue;
		const elementRoom = element.scrollHeight - element.clientHeight - element.scrollTop;
		if (element.clientHeight > innerHeight * 0.5 && elementRoom > room) {
			target = element;
			room = elementRoom;
		}
	}
	if (room <= 2) return false;
	target.scrollTop += Math.floor(Math.min(target.clientHeight, innerHeight) * 0.8);
	return true;
}

/**
 * Load a page, scroll it top to bottom, and record every image that enters the
 * viewport: natural size, rendered size, DPR, object-fit, bytes on the wire
 * and the response headers that show how it was transformed.
 */
export async function measurePage(
	browser,
	{ origin, name, path, viewportName, storageState, outDir },
) {
	const options = VIEWPORTS[viewportName];
	const context = await browser.newContext({ ...options, locale: "en-US", storageState });
	const page = await context.newPage();
	const responses = new Map();
	const pending = [];
	page.on("response", (response) => {
		if (response.request().resourceType() !== "image") return;
		pending.push(
			(async () => {
				const headers = response.headers();
				const status = response.status();
				let bytes = null;
				if (status < 300) bytes = (await response.body().catch(() => null))?.length ?? null;
				const entry = {
					status,
					bytes,
					contentType: headers["content-type"] ?? null,
					cfResized: headers["cf-resized"] ?? null,
					cacheStatus: headers["cf-cache-status"] ?? null,
					finalUrl: response.url(),
				};
				for (let req = response.request(); req; req = req.redirectedFrom()) {
					if (!responses.has(req.url()) || status < 300) responses.set(req.url(), entry);
				}
			})(),
		);
	});

	const started = Date.now();
	await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 120_000 });
	await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
	const loadMs = Date.now() - started;

	const seen = new Map();
	for (let step = 0; step < 60; step++) {
		await page
			.waitForFunction(
				() =>
					[...document.images].every((img) => {
						const rect = img.getBoundingClientRect();
						const visible = rect.bottom > 0 && rect.top < innerHeight && rect.width > 0;
						return !visible || img.complete;
					}),
				null,
				{ timeout: 15_000 },
			)
			.catch(() => {});
		const visible = await page.evaluate(collectVisibleImages);
		for (const image of visible) {
			if (!seen.has(image.id)) seen.set(image.id, { ...image, aboveFold: step === 0 });
		}
		const moved = await page.evaluate(scrollOneScreen);
		if (!moved) break;
		await page.waitForTimeout(500);
	}
	await Promise.all(pending);

	const dpr = options.deviceScaleFactor;
	const images = Array.from(seen.values(), ({ id: _id, ...image }) => {
		const response = responses.get(image.url) ?? null;
		return {
			...image,
			dpr,
			...classifyImageUrl(image.url, origin),
			bytes: response?.bytes ?? null,
			status: response?.status ?? null,
			contentType: response?.contentType ?? null,
			cfResized: response?.cfResized ?? null,
			redirectedTo: response && response.finalUrl !== image.url ? response.finalUrl : null,
		};
	});

	const screenshot = `${outDir}/${name.replaceAll(/\W+/g, "-")}-${viewportName}.png`;
	await page.evaluate(() => {
		for (const element of [document.scrollingElement, ...document.querySelectorAll("*")]) {
			if (element && element.scrollTop > 0) element.scrollTop = 0;
		}
	});
	await page.screenshot({ path: screenshot });
	await context.close();
	return { name, path, viewport: viewportName, loadMs, images, screenshot };
}
