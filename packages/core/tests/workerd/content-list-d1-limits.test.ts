import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { handleContentCreate, handleContentList } from "../../src/api/handlers/content.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import type { Database } from "../../src/database/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { listColumns, resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/**
 * A content list reads each entry's SEO, bylines and pending draft in the
 * same statement as the page, as one extra JSON column. D1 refuses a
 * statement with more than 100 result columns or bound parameters, so the
 * list must still work where that column or the fold's parameters would
 * cross either limit.
 */
const COLLECTION = "limits_d1";
const D1_COLUMN_LIMIT = 100;

let db: Kysely<Database>;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: COLLECTION,
		label: "Limits",
		supports: ["drafts", "revisions", "seo"],
	});
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });
});

afterEach(() => {
	setI18nConfig(null);
});

afterAll(async () => {
	await db.destroy();
});

async function createCreditedEntry(data: Record<string, unknown>) {
	const byline = await new BylineRepository(db).create({ slug: "writer", displayName: "Writer" });
	const created = await handleContentCreate(db, COLLECTION, {
		data,
		bylines: [{ bylineId: byline.id, roleLabel: "Words" }],
		seo: { title: "SEO title" },
	});
	if (!created.success) throw new Error(created.error.message);
	return created.data.item;
}

async function list(locale?: string) {
	const result = await runWithContext({ db, editMode: false }, () =>
		handleContentList(db, COLLECTION, { limit: 20, locale }),
	);
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data.items;
}

describe("content list at D1's limits", () => {
	it("lists a collection as wide as D1 allows", async () => {
		const registry = new SchemaRegistry(db);
		const width = (await listColumns(db, `ec_${COLLECTION}`)).length;
		for (let i = width; i < D1_COLUMN_LIMIT; i++) {
			await registry.createField(COLLECTION, {
				slug: `field_${i}`,
				label: `F${i}`,
				type: "string",
			});
		}
		expect(await listColumns(db, `ec_${COLLECTION}`)).toHaveLength(D1_COLUMN_LIMIT);
		const last = `field_${D1_COLUMN_LIMIT - 1}`;
		const entry = await createCreditedEntry({ title: "Wide", [last]: "last value" });

		const [item] = await list();

		expect(item?.id).toBe(entry.id);
		expect(item?.data[last]).toBe("last value");
		expect(item?.seo?.title).toBe("SEO title");
		expect(item?.bylines?.map((credit) => credit.roleLabel)).toEqual(["Words"]);
	});

	it("lists entries when locale aliases would take the fold past D1's bound parameters", async () => {
		const localeAliases = Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [`en-x${String(i).padStart(2, "0")}`, "en"]),
		);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], localeAliases });
		const entry = await createCreditedEntry({ title: "Aliased" });

		const [item] = await list("en");

		expect(item?.id).toBe(entry.id);
		expect(item?.seo?.title).toBe("SEO title");
		expect(item?.bylines?.map((credit) => credit.roleLabel)).toEqual(["Words"]);
	});
});
