import { describe, expectTypeOf, it } from "vitest";

import type { handleContentCompare } from "../../src/api/handlers/content.js";
import type { RevisionListResponse } from "../../src/api/handlers/revision.js";

type CompareData = Extract<
	Awaited<ReturnType<typeof handleContentCompare>>,
	{ success: true }
>["data"];

describe("revision responses written before fingerprints", () => {
	it("still fit the response types", () => {
		const list = {
			items: [
				{
					id: "rev",
					collection: "posts",
					entryId: "entry",
					data: {},
					authorId: null,
					createdAt: "2026-01-01",
					author: null,
					editedBy: null,
				},
			],
			total: 1,
		};
		expectTypeOf(list).toExtend<RevisionListResponse>();
		expectTypeOf({ hasChanges: false, live: null, draft: null }).toExtend<CompareData>();
	});
});
