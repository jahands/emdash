/**
 * `--seed-size large`: tens of thousands of entries written straight into
 * the content table with batched SQL, after the normal seed, so list,
 * count, archive and sitemap queries meet a table where a missing index
 * shows.
 */

import { mediaValue } from "./seed.mjs";

export const LARGE_SEED_ENTRIES = 50_000;
const YEARS = 6;
const DAY_MS = 24 * 3600_000;
const MAX_PARAMS = 30_000;
const FRACTIONAL_SECONDS = /\.\d+Z$/;
const SAFE_TABLE = /^[a-z][a-z0-9_]*$/;

/** Shares out of 100. */
export const STATUS_SHARES = [
	["published", 78],
	["draft", 12],
	["scheduled", 4],
	["trashed", 6],
];
export const LOCALE_SHARES = [
	["en", 88],
	["fr", 8],
	["de", 4],
];

/** Small deterministic PRNG, so every run seeds the same rows. */
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick(shares, roll) {
	let total = 0;
	for (const [value, share] of shares) {
		total += share;
		if (roll * 100 < total) return value;
	}
	return shares.at(-1)[0];
}

/** A 26-character ULID-shaped id that cannot collide with real ULIDs' timestamps. */
const bulkId = (i) => `00PERF${String(i).padStart(20, "0")}`;

/**
 * The rows to insert, oldest first. Dates spread over six years with more
 * entries in recent years; most entries are published, some are drafts,
 * scheduled or in the trash; most are English, and the French and German
 * ones are translations that share an English entry's slug and
 * translation group.
 */
export function bulkEntries(count, { now = Date.now(), seed = 1 } = {}) {
	const random = mulberry32(seed);
	const ages = Array.from({ length: count }, () => random() ** 2 * YEARS * 365 * DAY_MS).toSorted(
		(a, b) => b - a,
	);
	const untranslated = { fr: [], de: [] };
	return ages.map((age, i) => {
		const id = bulkId(i);
		const locale = pick(LOCALE_SHARES, random());
		const kind = pick(STATUS_SHARES, random());
		const created = now - age;
		const published = Math.min(now, created + random() * 6 * 3600_000);
		const updated = Math.min(now, published + random() ** 3 * 30 * DAY_MS);
		let translationGroup = id;
		let slug = `bulk-entry-${i}`;
		if (locale === "en") {
			untranslated.fr.push({ id, slug });
			untranslated.de.push({ id, slug });
		} else {
			const source = untranslated[locale].pop();
			if (source) {
				translationGroup = source.id;
				slug = source.slug;
			}
		}
		const entry = {
			id,
			slug,
			locale,
			translationGroup,
			status: kind === "trashed" ? (random() < 0.5 ? "published" : "draft") : kind,
			createdAt: new Date(created),
			updatedAt: new Date(updated),
			publishedAt: null,
			scheduledAt: null,
			deletedAt: null,
		};
		if (entry.status === "published") entry.publishedAt = new Date(published);
		if (kind === "scheduled") entry.scheduledAt = new Date(now + (1 + random() * 59) * DAY_MS);
		if (kind === "trashed")
			entry.deletedAt = new Date(Math.min(now, updated + random() * 90 * DAY_MS));
		return entry;
	});
}

/** Format `date` the way `sample`, a stored timestamp, is formatted. */
export function formatLike(sample, date) {
	const iso = date.toISOString();
	if (typeof sample !== "string" || sample.includes("T")) return iso;
	return iso.replace("T", " ").replace(FRACTIONAL_SECONDS, "");
}

/** Counts by a key, for the summary. */
function tally(rows, key) {
	const out = {};
	for (const row of rows) out[key(row)] = (out[key(row)] ?? 0) + 1;
	return out;
}

/** A short Portable Text body: a heading and three paragraphs. */
function bulkBody(i) {
	const text = (n) =>
		`Archive entry ${i}, paragraph ${n}. Long-running sites collect thousands of posts like this one, and every list, count and sitemap query has to page through them.`;
	return [
		{
			_type: "block",
			_key: `b${i}h`,
			style: "h2",
			markDefs: [],
			children: [{ _type: "span", _key: `b${i}hs`, text: `Entry ${i}`, marks: [] }],
		},
		...[1, 2, 3].map((n) => ({
			_type: "block",
			_key: `b${i}p${n}`,
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: `b${i}p${n}s`, text: text(n), marks: [] }],
		})),
	];
}

/**
 * Multi-row INSERT statements for `rows` into `table`, at most `batch`
 * rows each, using only the columns the table has.
 */
export function insertStatements(table, columns, rows, batch) {
	const statements = [];
	for (let i = 0; i < rows.length; i += batch) {
		const chunk = rows.slice(i, i + batch);
		const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
		statements.push({
			text: `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${placeholders}`,
			params: chunk.flatMap((row) => columns.map((c) => row[c] ?? null)),
		});
	}
	return statements;
}

async function tableColumns(site, table) {
	if (site.profile.usesPostgres) {
		const rows = await site.sql(
			"SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = current_schema()",
			[table],
		);
		return rows.map((r) => r.column_name);
	}
	return (await site.sql(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name);
}

/**
 * Insert `count` entries into the plan's collection with batched SQL, with
 * a featured image, a short body and a term each. The server must be
 * stopped. On Postgres the tables are analyzed afterwards, as autovacuum
 * would.
 */
export async function insertLargeSeed(
	site,
	{ plan, media, count = LARGE_SEED_ENTRIES, log = () => {} },
) {
	const started = Date.now();
	const table = `ec_${plan.collection}`;
	if (!SAFE_TABLE.test(table)) throw new Error(`Unexpected collection slug ${plan.collection}`);
	const columns = new Set(await tableColumns(site, table));
	const [sample] = await site.sql(
		`SELECT author_id, primary_byline_id, created_at FROM ${table} WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
	);
	const terms = (
		await site.sql(
			"SELECT DISTINCT taxonomy_id FROM content_taxonomies WHERE collection = ? ORDER BY taxonomy_id",
			[plan.collection],
		)
	).map((r) => r.taxonomy_id);
	const photos = media.filter((m) => m.mimeType === "image/jpeg");
	const entries = bulkEntries(count);
	const at = (date) => (date ? formatLike(sample?.created_at, date) : null);
	const rows = entries.map((e, i) => ({
		id: e.id,
		slug: e.slug,
		status: e.status,
		author_id: sample?.author_id ?? null,
		primary_byline_id: sample?.primary_byline_id ?? null,
		created_at: at(e.createdAt),
		updated_at: at(e.updatedAt),
		published_at: at(e.publishedAt),
		scheduled_at: at(e.scheduledAt),
		deleted_at: at(e.deletedAt),
		version: 1,
		locale: e.locale,
		translation_group: e.translationGroup,
		...(plan.titleField ? { [plan.titleField]: `Notes from the archive, entry ${i}` } : {}),
		...(plan.excerptField
			? { [plan.excerptField]: `Archive entry ${i} on a long-running site.` }
			: {}),
		...(photos.length > 0
			? {
					[plan.imageField]: JSON.stringify(
						mediaValue(photos[i % photos.length], `Archive photo ${i}`),
					),
				}
			: {}),
		[plan.bodyField]: JSON.stringify(bulkBody(i)),
	}));
	const used = Object.keys(rows[0]).filter((c) => columns.has(c));
	const batch = Math.max(1, Math.floor(MAX_PARAMS / used.length));
	const statements = insertStatements(table, used, rows, batch);
	if (terms.length > 0) {
		const links = entries.map((e, i) => ({
			collection: plan.collection,
			entry_id: e.id,
			taxonomy_id: terms[i % terms.length],
		}));
		statements.push(
			...insertStatements(
				"content_taxonomies",
				["collection", "entry_id", "taxonomy_id"],
				links,
				5000,
			),
		);
	}
	await site.sqlBatch(statements);
	if (site.profile.usesPostgres) await site.sql("ANALYZE");
	const summary = {
		collection: plan.collection,
		entries: count,
		byStatus: tally(entries, (e) => (e.deletedAt ? "trashed" : e.status)),
		byLocale: tally(entries, (e) => e.locale),
		withTerm: terms.length > 0 ? count : 0,
		seconds: Math.round((Date.now() - started) / 100) / 10,
	};
	log(`  large seed: ${count} entries in ${summary.seconds}s ${JSON.stringify(summary.byStatus)}`);
	return summary;
}
