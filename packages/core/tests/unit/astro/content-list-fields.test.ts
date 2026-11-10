import { Role } from "@emdash-cms/auth";
import { describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/content/[collection]/index.js";

describe("content list response fields", () => {
	it.each(["", "&fields=title,event_date"])("projects only when requested (%s)", async (fields) => {
		const item = {
			id: "post-1",
			locale: "ar",
			data: { title: "Title", event_date: "2026-01-01", content: "Large body" },
		};
		const handleContentList = vi
			.fn()
			.mockResolvedValue({ success: true, data: { items: [item], total: 1, nextCursor: "next" } });
		const url = new URL(`http://localhost/_emdash/api/content/posts?locale=ar${fields}`);
		const response = await GET({
			params: { collection: "posts" },
			url,
			locals: { user: { id: "editor", role: Role.EDITOR }, emdash: { handleContentList } },
		} as unknown as Parameters<typeof GET>[0]);
		const json = await response.json();
		expect(json.data).toMatchObject({
			total: 1,
			nextCursor: "next",
			items: [{ id: "post-1", locale: "ar" }],
		});
		expect(json.data.items[0].data).toEqual(
			fields ? { title: "Title", event_date: "2026-01-01" } : item.data,
		);
		expect(handleContentList.mock.calls[0][1].locale).toBe("ar");
		expect(item.data.content).toBe("Large body");
	});
});
