/**
 * Bring a fresh site to a production-shaped state through the product's own
 * paths: the setup wizard routes apply the template seed, then an owner
 * uploads photos and screenshots in the admin and edits content over the
 * HTTP API.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cookieHeader, createFirstAdmin, exchangeSignInToken, issueSignInToken } from "./auth.mjs";
import { sleep } from "./proc.mjs";

export const EXTRA_ENTRIES = 52;
const GET_STARTED = /get started/i;
const UPLOAD = /upload/i;
const BODY_PARAGRAPHS = 18;

export function apiClient(origin, cookies) {
	const cookie = cookies ? cookieHeader(cookies) : "";
	return async function api(method, path, body) {
		const init = {
			method,
			headers: {
				"X-EmDash-Request": "1",
				Origin: origin,
				...(cookie ? { Cookie: cookie } : {}),
			},
		};
		if (body !== undefined) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}
		const response = await fetch(`${origin}/_emdash/api${path}`, init);
		const text = await response.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			json = { raw: text.slice(0, 300) };
		}
		if (!response.ok) {
			const error = new Error(
				`${method} ${path} -> ${response.status}: ${JSON.stringify(json).slice(0, 400)}`,
			);
			error.status = response.status;
			error.body = json;
			throw error;
		}
		return json.data ?? json;
	};
}

export async function runSetupWizard(origin) {
	const api = apiClient(origin);
	for (let attempt = 0; attempt < 40; attempt++) {
		const result = await api("POST", "/setup", {
			title: "Perf Audit Blog",
			tagline: "Production-shaped content for performance audits",
			includeContent: true,
		});
		if (result.seedComplete) return result;
	}
	throw new Error("Setup did not finish applying the seed after 40 requests");
}

/**
 * Sign in as the owner. Local D1 is a file owned by workerd, so the token
 * row is written while the server is stopped.
 */
export async function signIn(site) {
	const restart = site.profile.database === "d1" && site.server;
	if (restart) await site.stop();
	const token = await issueSignInToken(site);
	if (restart) await site.start();
	return exchangeSignInToken(site.origin, token);
}

/** The welcome dialog shows once per user; dismissing it is stored server-side. */
async function dismissWelcome(page) {
	const button = page.getByRole("button", { name: GET_STARTED });
	try {
		await button.waitFor({ state: "visible", timeout: 8_000 });
	} catch {
		return;
	}
	await button.click();
	await button.waitFor({ state: "hidden" });
}

async function uploadThroughAdmin(browser, site, cookies, files) {
	const api = apiClient(site.origin, cookies);
	const before = (await api("GET", "/media?limit=100")).items.length;
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await context.addCookies(cookies);
	const page = await context.newPage();
	try {
		await page.goto(`${site.origin}/_emdash/admin/media`);
		await dismissWelcome(page);
		await page.getByRole("button", { name: UPLOAD }).first().click();
		await page.locator('input[type="file"][multiple]').setInputFiles(files.map((f) => f.path));
		const deadline = Date.now() + 300_000;
		while (Date.now() < deadline) {
			const count = (await api("GET", "/media?limit=100")).items.length;
			if (count >= before + files.length) break;
			await sleep(1000);
		}
		await sleep(500);
	} finally {
		await context.close();
	}
	const items = (await api("GET", "/media?limit=100")).items;
	const uploaded = files.map((file) => items.find((item) => item.filename === file.name));
	const missing = files.filter((_, i) => !uploaded[i]).map((f) => f.name);
	if (missing.length > 0) throw new Error(`Uploads did not finish: ${missing.join(", ")}`);
	return uploaded;
}

function mediaValue(item, alt) {
	return {
		provider: "local",
		id: item.id,
		src: item.url,
		alt,
		width: item.width,
		height: item.height,
		mimeType: item.mimeType,
		filename: item.filename,
		...(item.blurhash ? { blurhash: item.blurhash } : {}),
		...(item.dominantColor ? { dominantColor: item.dominantColor } : {}),
	};
}

function imageBlock(item, key, alt) {
	return {
		_type: "image",
		_key: key,
		asset: { _ref: item.id, url: item.url, provider: "local" },
		alt,
		width: item.width,
		height: item.height,
		...(item.blurhash ? { blurhash: item.blurhash } : {}),
		...(item.dominantColor ? { dominantColor: item.dominantColor } : {}),
	};
}

const SENTENCES = [
	"Owners write longer posts than the seed suggests, with headings and photos between sections.",
	"A paragraph like this one wraps across several lines on a phone and a couple on a laptop.",
	"Screenshots show the exact state of an interface, so they tend to be large lossless files.",
	"Most images come straight from a camera or a phone and are uploaded without resizing.",
	"Lists paginate once a site has been running for a while, which changes what the queries do.",
];

function paragraph(i, key) {
	const text = Array.from({ length: 4 }, (_, j) => SENTENCES[(i + j) % SENTENCES.length]).join(" ");
	return {
		_type: "block",
		_key: key,
		style: i % 6 === 0 ? "h2" : "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
	};
}

/**
 * A long body with `imageCount` distinct images spread between its
 * paragraphs, starting at `media[offset]`.
 */
export function longBody(media, offset, imageCount) {
	if (imageCount > media.length) {
		throw new Error(`A body cannot hold ${imageCount} distinct images from ${media.length} files`);
	}
	const paragraphs = Math.max(BODY_PARAGRAPHS, imageCount + 1);
	const after = new Set(
		Array.from({ length: imageCount }, (_, k) =>
			Math.floor(((k + 1) * paragraphs) / (imageCount + 1)),
		),
	);
	const blocks = [];
	let placed = 0;
	for (let i = 0; i < paragraphs; i++) {
		blocks.push(paragraph(i + offset, `p${offset}-${i}`));
		if (after.has(i + 1) && placed < imageCount) {
			const item = media[(offset + placed) % media.length];
			blocks.push(imageBlock(item, `img${offset}-${placed}`, `Photo ${item.filename}`));
			placed++;
		}
	}
	return blocks;
}

/** Image blocks in a Portable Text body and how many distinct assets they use. */
export function countBodyImages(blocks) {
	const images = (Array.isArray(blocks) ? blocks : []).filter((b) => b?._type === "image");
	return { blocks: images.length, distinct: new Set(images.map((b) => b.asset?._ref)).size };
}

/**
 * Throw when the image-heavy entry as stored does not have one body image
 * per uploaded file and a featured image, so the seed cannot drift from
 * what the summary says it measured.
 */
export function assertHeaviestEntry(stored, { mediaCount, imageField, bodyField }) {
	const counts = countBodyImages(stored?.[bodyField]);
	const featured = Boolean(stored?.[imageField]?.id ?? stored?.[imageField]?.src);
	if (counts.blocks !== mediaCount || counts.distinct !== mediaCount || !featured) {
		throw new Error(
			`The image-heavy entry has ${counts.blocks} body image blocks using ${counts.distinct} distinct files and ${featured ? "a" : "no"} featured image; expected ${mediaCount} distinct body images and a featured image.`,
		);
	}
	return { bodyImages: counts.blocks, distinctBodyImages: counts.distinct, featured };
}

/**
 * Decide which collection the owner fills with images, from the template's
 * seed: the one with an image field and a rich-text field and the most
 * seeded entries. Returns null when the template has no such collection.
 */
export function planOwnerEdits(seed) {
	const candidates = (seed.collections ?? [])
		.map((collection) => {
			const field = (type) => collection.fields.find((f) => f.type === type)?.slug ?? null;
			const textField = (...slugs) =>
				slugs.find((slug) => collection.fields.some((f) => f.slug === slug)) ?? null;
			const taxonomy = (seed.taxonomies ?? []).find((t) =>
				(t.collections ?? []).includes(collection.slug),
			);
			return {
				collection: collection.slug,
				imageField: field("image"),
				bodyField: field("portableText"),
				titleField: textField("title", "name"),
				excerptField: textField("excerpt", "summary", "description"),
				taxonomy: taxonomy?.name ?? null,
				terms: (taxonomy?.terms ?? []).map((t) => t.slug),
				seeded: (seed.content?.[collection.slug] ?? []).length,
			};
		})
		.filter((c) => c.imageField && c.bodyField)
		.toSorted((a, b) => b.seeded - a.seeded);
	return candidates[0] ?? null;
}

async function publish(api, collection, id) {
	await api("POST", `/content/${collection}/${id}/publish`, {});
}

function newEntryData(plan, { title, excerpt, image, body }) {
	return {
		...(plan.titleField ? { [plan.titleField]: title } : {}),
		...(plan.excerptField ? { [plan.excerptField]: excerpt } : {}),
		[plan.imageField]: image,
		[plan.bodyField]: body,
	};
}

/**
 * Owner edits: a featured image on every entry, images inside bodies, one
 * long image-heavy entry, and enough extra entries for lists to paginate.
 */
export async function ownerEdits(api, media, plan) {
	const { collection, imageField, bodyField } = plan;
	const photos = media.filter((m) => m.mimeType === "image/jpeg");
	const entries = (await api("GET", `/content/${collection}?limit=100`)).items;
	const summary = { collection, featured: 0, bodyImages: 0, created: 0, heaviestEntry: null };
	const taxonomies = (i) =>
		plan.taxonomy && plan.terms.length > 0
			? { [plan.taxonomy]: [plan.terms[i % plan.terms.length]] }
			: undefined;

	for (const [i, listed] of entries.entries()) {
		const full = await api("GET", `/content/${collection}/${listed.id}`);
		const entry = full.item ?? full;
		const content = Array.isArray(entry.data?.[bodyField]) ? entry.data[bodyField] : [];
		const withImage = [...content];
		withImage.splice(
			Math.min(2, withImage.length),
			0,
			imageBlock(media[(i + 3) % media.length], `owner-img-${i}`, "Owner photo"),
		);
		await api("PUT", `/content/${collection}/${listed.id}`, {
			data: {
				[imageField]: mediaValue(photos[i % photos.length], `Featured photo ${i + 1}`),
				[bodyField]: withImage,
			},
			_rev: full._rev ?? entry._rev,
		});
		await publish(api, collection, listed.id);
		summary.featured++;
		summary.bodyImages++;
	}

	const heavy = await api("POST", `/content/${collection}`, {
		data: newEntryData(plan, {
			title: "A field guide with every photo",
			excerpt: "The longest entry on the site, with images between most sections.",
			image: mediaValue(photos[0], "Harbor at sunrise"),
			body: longBody(media, 0, media.length),
		}),
		slug: "field-guide-every-photo",
		taxonomies: taxonomies(0),
	});
	const heavyId = (heavy.item ?? heavy).id;
	await publish(api, collection, heavyId);
	const stored = await api("GET", `/content/${collection}/${heavyId}`);
	const counts = assertHeaviestEntry((stored.item ?? stored).data, {
		mediaCount: media.length,
		imageField,
		bodyField,
	});
	summary.heaviestEntry = {
		id: heavyId,
		slug: "field-guide-every-photo",
		images: counts.bodyImages,
		distinctImages: counts.distinctBodyImages,
		featuredImage: counts.featured,
	};
	summary.bodyImages += counts.bodyImages;
	summary.featured++;
	summary.created++;

	for (let i = 0; i < EXTRA_ENTRIES; i++) {
		const n = i + 1;
		const created = await api("POST", `/content/${collection}`, {
			data: newEntryData(plan, {
				title: `Notes from the archive, part ${n}`,
				excerpt: `Archive entry ${n}, written to give lists enough rows to paginate.`,
				image: mediaValue(photos[n % photos.length], `Archive photo ${n}`),
				body: longBody(media, n, 2),
			}),
			slug: `archive-notes-${n}`,
			taxonomies: taxonomies(i),
		});
		await publish(api, collection, (created.item ?? created).id);
		summary.bodyImages += 2;
		summary.created++;
	}
	return summary;
}

/** Leave media usage tracking on with collection indexing unfinished. */
export async function leaveMediaUsageIndexing(api) {
	let status = await api("GET", "/admin/media-usage/activation");
	for (let i = 0; i < 20 && status.state !== "active"; i++) {
		const advanced = await api("POST", "/admin/media-usage/activation", { confirm: true });
		status = advanced.activation ?? advanced;
	}
	let progress = null;
	try {
		progress = await api("GET", "/admin/media-usage/progress");
	} catch (error) {
		progress = { error: error.message };
	}
	return { activation: status.state, progress };
}

export async function seedSite({ browser, site, mediaFiles, log }) {
	const templateSeed = JSON.parse(readFileSync(join(site.siteDir, "seed/seed.json"), "utf8"));
	const plan = planOwnerEdits(templateSeed);
	const started = Date.now();
	const setup = await runSetupWizard(site.origin);
	log(`  setup wizard applied the seed (${JSON.stringify(setup.result?.content ?? {})})`);
	await createFirstAdmin(browser, site.origin);
	log("  first admin created with a virtual passkey");
	const cookies = await signIn(site);
	const api = apiClient(site.origin, cookies);
	const media = await uploadThroughAdmin(browser, site, cookies, mediaFiles);
	log(`  uploaded ${media.length} files through the media library`);
	const edits = plan
		? await ownerEdits(api, media, plan)
		: { skipped: "no collection with image and rich-text fields" };
	log(`  owner edits: ${JSON.stringify(edits)}`);
	const usage = await leaveMediaUsageIndexing(api);
	log(`  media usage: ${JSON.stringify(usage)}`);
	const folders = await api("GET", "/media/folders").catch(() => null);
	return {
		seconds: Math.round((Date.now() - started) / 1000),
		media: media.map((m) => ({
			id: m.id,
			filename: m.filename,
			size: m.size,
			width: m.width,
			height: m.height,
		})),
		edits,
		mediaUsage: usage,
		mediaFolders: Array.isArray(folders?.items) ? folders.items.length : folders,
	};
}
