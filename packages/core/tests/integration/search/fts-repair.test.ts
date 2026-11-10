import type { Kysely, KyselyPlugin } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager } from "../../../src/search/fts-manager.js";
import { searchWithDb } from "../../../src/search/query.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("FTS repair", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;
	let repo: ContentRepository;
	let ftsManager: FTSManager;
	let gameId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		repo = new ContentRepository(db);
		ftsManager = new FTSManager(db);

		await registry.createCollection({
			slug: "game",
			label: "Games",
			labelSingular: "Game",
			supports: ["search"],
		});
		await registry.createField("game", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createField("game", {
			slug: "blurb",
			label: "Blurb",
			type: "text",
			searchable: true,
		});

		const created = await repo.create({
			type: "game",
			slug: "trail-of-cthulhu",
			status: "published",
			publishedAt: new Date().toISOString(),
			data: {
				title: "Trail of Cthulhu",
				blurb: "Investigative horror in the Cthulhu mythos.",
			},
		});
		gameId = created.id;

		await ftsManager.enableSearch("game");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("recreates a missing FTS table when search remains enabled", async () => {
		expect(await ftsManager.ftsTableExists("game")).toBe(true);

		await ftsManager.dropFtsTable("game");

		expect(await ftsManager.ftsTableExists("game")).toBe(false);
		expect(
			await searchWithDb(db, "cthulhu", {
				collections: ["game"],
				status: "published",
			}),
		).toEqual({ items: [] });

		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(1);
		expect(await ftsManager.ftsTableExists("game")).toBe(true);

		const repaired = await searchWithDb(db, "cthulhu", {
			collections: ["game"],
			status: "published",
		});

		expect(repaired.items).toHaveLength(1);
		expect(repaired.items[0]?.slug).toBe("trail-of-cthulhu");
	});

	describe("verifying several collections", () => {
		async function addSearchableCollection(slug: string): Promise<void> {
			await registry.createCollection({
				slug,
				label: slug,
				labelSingular: slug,
				supports: ["search"],
			});
			await registry.createField(slug, {
				slug: "title",
				label: "Title",
				type: "string",
				searchable: true,
			});
			await repo.create({
				type: slug,
				slug: `${slug}-entry`,
				status: "published",
				publishedAt: new Date().toISOString(),
				data: { title: `${slug} needle` },
			});
			await ftsManager.enableSearch(slug);
		}

		function countingManager(): { manager: FTSManager; statements: () => number } {
			let count = 0;
			const counter: KyselyPlugin = {
				transformQuery: ({ node }) => {
					count++;
					return node;
				},
				transformResult: async ({ result }) => result,
			};
			return { manager: new FTSManager(db.withPlugin(counter)), statements: () => count };
		}

		it("verifies more collections with the same number of statements", async () => {
			const healthy = countingManager();
			await expect(healthy.manager.verifyAndRepairAll()).resolves.toBe(0);
			const forOne = healthy.statements();
			expect(forOne).toBeLessThanOrEqual(3);

			await addSearchableCollection("book");
			await addSearchableCollection("film");

			const withMore = countingManager();
			await expect(withMore.manager.verifyAndRepairAll()).resolves.toBe(0);
			expect(withMore.statements()).toBe(forOne);
		});

		it("rebuilds only the damaged indexes among healthy ones", async () => {
			await addSearchableCollection("book");
			await addSearchableCollection("film");
			await ftsManager.dropFtsTable("book");
			await sql
				.raw(
					`DELETE FROM "_emdash_fts_film" WHERE rowid IN (SELECT rowid FROM "_emdash_fts_film" LIMIT 1)`,
				)
				.execute(db);

			await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(2);

			expect(await ftsManager.ftsTableExists("book")).toBe(true);
			const book = await searchWithDb(db, "needle", { collections: ["book"], status: "published" });
			const film = await searchWithDb(db, "needle", { collections: ["film"], status: "published" });
			expect(book.items).toHaveLength(1);
			expect(film.items).toHaveLength(1);
		});

		it("keeps verifying the other collections when a table cannot be counted", async () => {
			await addSearchableCollection("book");
			await addSearchableCollection("film");
			await sql.raw(`DROP TABLE "ec_book"`).execute(db);
			await sql.raw(`DELETE FROM "_emdash_fts_film"`).execute(db);
			const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

			try {
				await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(1);
				expect(error).toHaveBeenCalledWith(
					expect.stringContaining('Failed to verify/repair FTS index for "book"'),
					expect.anything(),
				);
				const film = await searchWithDb(db, "needle", {
					collections: ["film"],
					status: "published",
				});
				expect(film.items).toHaveLength(1);
			} finally {
				error.mockRestore();
			}
		});
	});

	it("keeps the FTS index in sync after soft delete", async () => {
		await expect(repo.delete("game", gameId)).resolves.toBe(true);
		await expect(ftsManager.verifyAndRepairAll()).resolves.toBe(0);
	});
});
