import { afterEach, beforeEach, expect, it } from "vitest";

import { handleMediaBatchGet } from "../../../src/api/handlers/media.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("batch media reads", (dialect) => {
	let ctx: DialectTestContext;
	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});
	it("returns existing metadata across SQL chunks, omits missing ids, and clamps requests", async () => {
		const repo = new MediaRepository(ctx.db);
		const ids: string[] = [];
		for (let i = 0; i < 105; i++) {
			const item = await repo.create({
				filename: `${i}.png`,
				mimeType: "image/png",
				storageKey: `${i}.png`,
				contentHash: `hash-${i}`,
			});
			ids.push(item.id);
		}
		const result = await handleMediaBatchGet(ctx.db, [
			...ids.slice(0, 99),
			"missing",
			...ids.slice(99),
		]);
		if (!result.success) throw new Error(result.error.message);
		expect(result.data.items).toHaveLength(99);
		expect(result.data.items.find((item) => item.id === ids[51])?.contentHash).toBe("hash-51");
		expect(result.data.items.some((item) => item.id === ids[100])).toBe(false);
	});
});

it("rejects a batch without the same media read permission as single reads", async () => {
	const { GET } = await import("../../../src/astro/routes/api/media.js");
	const response = await GET({
		request: new Request("http://localhost/_emdash/api/media?ids=a,b"),
		locals: {},
	} as Parameters<typeof GET>[0]);
	expect(response.status).toBe(401);
});
