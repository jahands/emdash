/**
 * Deterministic, realistic-volume seed for the perf audit.
 *
 * Extends fixtures/perf-site/seed/seed.json, so the fixture's public routes
 * keep working, and replaces its remote images with generated local files so
 * the audit needs no network and renders the same bytes every run.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";

export const COUNTS = {
	posts: 480,
	pages: 40,
	products: 180,
	images: 120,
	categories: 28,
	tags: 140,
	bylines: 24,
	users: 40,
	comments: 300,
	redirects: 60,
	longPostBlocks: 1500,
};

export const LONG_POST_SLUG = "the-long-read";
const PRODUCT_SLUG_PREFIX = "product-";
const IMAGE_SIZES = [
	[1200, 800],
	[800, 1200],
	[1600, 900],
	[1000, 1000],
];

const WORDS = `the of and a to in is you that it he was for on are as with his they at be this
have from or one had by word but not what all were we when your can said there use an each which
she do how their if will up other about out many then them these so some her would make like him
into time has look two more write go see number no way could people my than first water been call
who oil its now find long down day did get come made may part content editor layout render query
cache schema theme plugin draft publish media block paragraph heading image gallery review system
network browser server static public archive feature release design article reader writer history`.split(
	/\s+/,
);

function createRng(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function words(rng, count) {
	const out = [];
	for (let index = 0; index < count; index++) out.push(pick(rng, WORDS));
	return out.join(" ");
}

function sentence(rng, count) {
	const text = words(rng, count);
	return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function title(rng, count) {
	return words(rng, count)
		.split(" ")
		.map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
		.join(" ");
}

function block(style, text) {
	return { _type: "block", style, children: [{ _type: "span", text }] };
}

function pngChunk(type, data) {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, checksum]);
}

function generatePng(width, height, rng) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const [red, green, blue] = [rng() * 255, rng() * 255, rng() * 255];
	const raw = Buffer.alloc((width * 3 + 1) * height);
	// Noise repeated in blocks keeps files near photo size (hundreds of KB, not MB).
	const blockNoise = Array.from({ length: Math.ceil(width / 6) + 1 }).fill(0);
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0;
		if (y % 6 === 0) {
			for (let cell = 0; cell < blockNoise.length; cell++) blockNoise[cell] = rng() * 26;
		}
		for (let x = 0; x < width; x++) {
			const noise = blockNoise[Math.floor(x / 6)];
			raw[offset++] = (red + (x / width) * 90 + noise) % 256;
			raw[offset++] = (green + (y / height) * 90 + noise) % 256;
			raw[offset++] = (blue + ((x + y) / (width + height)) * 90 + noise) % 256;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw, { level: 6 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function longPostBody(rng, images) {
	const body = [];
	for (let index = 0; index < COUNTS.longPostBlocks; index++) {
		if (index % 60 === 0) body.push(block("h2", title(rng, 5)));
		else if (index % 97 === 0)
			body.push({
				_type: "code",
				language: "javascript",
				code: `const value = ${index};\nconsole.log(value);`,
			});
		else if (index % 41 === 0) {
			const image = pick(rng, images);
			body.push({
				_type: "image",
				asset: image.$media,
				alt: image.$media.alt,
				width: image.width,
				height: image.height,
			});
		} else
			body.push(block("normal", `${sentence(rng, 18)} ${sentence(rng, 26)} ${sentence(rng, 14)}`));
	}
	return body.map((item) =>
		item._type === "image" ? { ...item, asset: { $media: item.asset } } : item,
	);
}

/**
 * Writes `seed.json` and its images into `dir`, plus avatar files under
 * `uploadsDir`, because seeded bylines reference storage keys directly.
 */
export function writeAuditSeed({ dir, uploadsDir, baseSeedPath }) {
	const rng = createRng(0xc0ffee);
	const seed = JSON.parse(readFileSync(baseSeedPath, "utf8"));

	mkdirSync(join(dir, "images"), { recursive: true });
	const images = [];
	for (let index = 0; index < COUNTS.images; index++) {
		const [width, height] = IMAGE_SIZES[index % IMAGE_SIZES.length];
		const file = `images/image-${String(index).padStart(3, "0")}.png`;
		writeFileSync(join(dir, file), generatePng(width, height, rng));
		images.push({
			width,
			height,
			$media: { file, alt: `Seeded image ${index}`, filename: `image-${index}.png` },
		});
	}

	for (const collection of Object.values(seed.content)) {
		for (const entry of collection) {
			if (entry.data.featured_image)
				entry.data.featured_image = { $media: pick(rng, images).$media };
		}
	}

	const categories = [];
	for (let index = 0; index < COUNTS.categories; index++) {
		categories.push({
			slug: `category-${index}`,
			label: title(rng, 2),
			...(index % 4 === 3 ? { parent: `category-${index - 1}` } : {}),
		});
	}
	const tags = [];
	for (let index = 0; index < COUNTS.tags; index++) {
		tags.push({ slug: `tag-${index}`, label: title(rng, 2) });
	}
	seed.taxonomies.find((taxonomy) => taxonomy.name === "category").terms.push(...categories);
	seed.taxonomies.find((taxonomy) => taxonomy.name === "tag").terms.push(...tags);

	for (let index = 0; index < COUNTS.bylines; index++) {
		seed.bylines.push({
			id: `generated-author-${index}`,
			slug: `generated-author-${index}`,
			displayName: title(rng, 2),
			avatar: {
				storageKey: `seed/avatars/generated-${index}.png`,
				alt: "Avatar",
				mimeType: "image/png",
				width: 200,
				height: 200,
			},
		});
	}
	for (const byline of seed.bylines) {
		const path = join(uploadsDir, byline.avatar.storageKey);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, generatePng(200, 200, rng));
	}

	seed.collections.push({
		slug: "products",
		label: "Products",
		labelSingular: "Product",
		supports: ["drafts", "revisions", "search"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
			{ slug: "sku", label: "SKU", type: "string" },
			{ slug: "price", label: "Price", type: "number" },
			{ slug: "in_stock", label: "In stock", type: "boolean" },
			{ slug: "image", label: "Image", type: "image" },
			{ slug: "description", label: "Description", type: "portableText", searchable: true },
		],
	});

	const posts = [];
	for (let index = 0; index < COUNTS.posts; index++) {
		posts.push({
			id: `generated-post-${index}`,
			slug: `generated-post-${index}`,
			status: index % 8 === 7 ? "draft" : "published",
			data: {
				title: title(rng, 5),
				excerpt: sentence(rng, 24),
				featured_image: { $media: images[index % images.length].$media },
				content: Array.from({ length: 12 }, () => block("normal", sentence(rng, 40))),
			},
			bylines: [{ byline: seed.bylines[index % seed.bylines.length].id }],
			taxonomies: {
				category: [
					categories[index % categories.length].slug,
					...(index < 60 ? ["development"] : []),
				],
				tag: [
					tags[index % tags.length].slug,
					tags[(index * 7) % tags.length].slug,
					...(index < 60 ? ["webdev"] : []),
				],
			},
		});
	}
	posts.push({
		id: "long-post",
		slug: LONG_POST_SLUG,
		status: "published",
		data: {
			title: "The Long Read",
			excerpt: sentence(rng, 24),
			featured_image: { $media: images[0].$media },
			content: longPostBody(rng, images),
		},
		bylines: [{ byline: seed.bylines[0].id }],
	});
	seed.content.posts.push(...posts);

	for (let index = 0; index < COUNTS.pages; index++) {
		seed.content.pages.push({
			id: `generated-page-${index}`,
			slug: `generated-page-${index}`,
			status: "published",
			data: {
				title: title(rng, 3),
				content: Array.from({ length: 8 }, () => block("normal", sentence(rng, 36))),
			},
		});
	}

	seed.content.products = [];
	for (let index = 0; index < COUNTS.products; index++) {
		seed.content.products.push({
			id: `generated-product-${index}`,
			slug: `${PRODUCT_SLUG_PREFIX}${index}`,
			status: index % 10 === 9 ? "draft" : "published",
			data: {
				title: title(rng, 3),
				sku: `SKU-${String(index).padStart(5, "0")}`,
				price: Math.round(rng() * 50_000) / 100,
				in_stock: index % 3 !== 0,
				image: { $media: images[(index * 3) % images.length].$media },
				description: Array.from({ length: 3 }, () => block("normal", sentence(rng, 30))),
			},
		});
	}

	seed.menus[0].items.push(
		...Array.from({ length: 6 }, (_, index) => ({
			type: "custom",
			label: title(rng, 1),
			url: `/pages/generated-page-${index}`,
		})),
	);
	seed.menus.push({
		name: "footer",
		label: "Footer Navigation",
		items: Array.from({ length: 36 }, (_, index) => ({
			type: "custom",
			label: title(rng, 2),
			url: `/pages/generated-page-${index}`,
		})),
	});
	seed.redirects = Array.from({ length: COUNTS.redirects }, (_, index) => ({
		source: `/old/path-${index}`,
		destination: `/posts/generated-post-${index}`,
	}));

	const seedPath = join(dir, "seed.json");
	writeFileSync(seedPath, JSON.stringify(seed));
	return seedPath;
}
