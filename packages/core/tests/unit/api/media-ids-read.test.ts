import { Role } from "@emdash-cms/auth";
import type { Kysely, KyselyPlugin } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleMediaGet, handleMediaList } from "../../../src/api/handlers/media.js";
import { GET as listMedia } from "../../../src/astro/routes/api/media.js";
import { MediaRepository, type MediaItem } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type ListRouteContext = Parameters<typeof listMedia>[0];

interface ListBody {
	data?: { items: Array<MediaItem & { url: string }>; nextCursor?: string };
	error?: { code: string };
}

function countQueries(db: Kysely<Database>): { db: Kysely<Database>; count: () => number } {
	let queries = 0;
	const plugin: KyselyPlugin = {
		transformQuery: (args) => {
			queries++;
			return args.node;
		},
		transformResult: async (args) => args.result,
	};
	return { db: db.withPlugin(plugin), count: () => queries };
}

describeEachDialect("GET /media?ids=", (dialect) => {
	let ctx: DialectTestContext;
	let items: MediaItem[];

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const repo = new MediaRepository(ctx.db);
		items = [];
		for (let index = 0; index < 3; index++) {
			items.push(
				await repo.create({
					filename: `photo-${index}.jpg`,
					mimeType: "image/jpeg",
					storageKey: `photo-${index}.jpg`,
					width: 4000,
					height: 3000,
					contentHash: `sha1:${index}`,
				}),
			);
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function list(query: string, db: Kysely<Database> = ctx.db) {
		const response = (await listMedia({
			request: new Request(`http://localhost/_emdash/api/media${query}`),
			locals: {
				emdash: {
					db,
					handleMediaList: (params: Parameters<typeof handleMediaList>[1]) =>
						handleMediaList(db, params),
					handleMediaGet: (id: string) => handleMediaGet(db, id),
				},
				user: { id: "user-1", role: Role.CONTRIBUTOR },
			},
		} as unknown as ListRouteContext)) as Response;
		return { status: response.status, body: (await response.json()) as ListBody };
	}

	it("returns the requested items in the order asked, with their file URLs, in one query", async () => {
		const counted = countQueries(ctx.db);
		const { status, body } = await list(
			`?ids=${items[2]!.id},missing,${items[0]!.id},${items[2]!.id}`,
			counted.db,
		);

		expect(status).toBe(200);
		expect(body.data?.items.map((item) => item.id)).toEqual([items[2]!.id, items[0]!.id]);
		expect(body.data?.items[0]).toMatchObject({
			url: "/_emdash/api/media/file/photo-2.jpg",
			mimeType: "image/jpeg",
			width: 4000,
			height: 3000,
			contentHash: "sha1:2",
		});
		expect(body.data?.nextCursor).toBeUndefined();
		expect(counted.count()).toBe(1);
	});

	it("reads 100 ids, the most one request takes, in one query", async () => {
		const ids = [items[1]!.id, ...Array.from({ length: 99 }, (_, index) => `missing-${index}`)];
		const counted = countQueries(ctx.db);

		const { status, body } = await list(`?ids=${ids.join(",")}`, counted.db);

		expect(status).toBe(200);
		expect(body.data?.items.map((item) => item.id)).toEqual([items[1]!.id]);
		expect(counted.count()).toBe(1);
	});

	it("rejects more than 100 ids", async () => {
		const ids = Array.from({ length: 101 }, (_, index) => `media-${index}`);
		const { status, body } = await list(`?ids=${ids.join(",")}`);

		expect(status).toBe(400);
		expect(body.error?.code).toBe("VALIDATION_ERROR");
	});

	it("rejects ids combined with list filters or pagination", async () => {
		for (const extra of ["&cursor=abc", "&page=1", "&q=photo", "&folderId=unfiled"]) {
			const { status } = await list(`?ids=${items[0]!.id}${extra}`);
			expect(status).toBe(400);
		}
	});

	it("leaves the paginated list unchanged without ids", async () => {
		const { status, body } = await list("?limit=2");

		expect(status).toBe(200);
		expect(body.data?.items).toHaveLength(2);
		expect(body.data?.nextCursor).toBeTypeOf("string");
	});
});
