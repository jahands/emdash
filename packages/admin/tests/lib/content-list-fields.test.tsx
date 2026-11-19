import * as React from "react";
import { describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { AdminManifest } from "../../src/lib/api";
import { useContentListFields } from "../../src/lib/content-list-fields.js";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context.js";

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: [],
			hasSeo: false,
			titleField: "headline",
			dateField: "event_date",
			listColumns: ["rating", "headline"],
			fields: {
				headline: { kind: "string", label: "Headline" },
				event_date: { kind: "datetime", label: "Event date" },
				rating: { kind: "number", label: "Rating" },
				body: { kind: "portableText", label: "Body" },
			},
		},
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: [],
			hasSeo: false,
			dateField: "publishedAt",
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: { columns: { enabled: true } },
	taxonomies: [],
};

function Cell(): React.ReactNode {
	return null;
}

async function listFields(collection: string, pluginAdmins: PluginAdmins = {}) {
	const { result } = await renderHook(() => useContentListFields(collection, manifest), {
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<PluginAdminProvider pluginAdmins={pluginAdmins}>{children}</PluginAdminProvider>
		),
	});
	return result.current;
}

describe("useContentListFields", () => {
	it("asks for the title fields, a custom date field and the list columns", async () => {
		expect(await listFields("posts")).toEqual([
			"title",
			"name",
			"headline",
			"event_date",
			"rating",
		]);
	});

	it("leaves out a system date field, which is not entry data", async () => {
		expect(await listFields("pages")).toEqual(["title", "name"]);
	});

	it("asks for whole entries while the manifest is loading", async () => {
		const { result } = await renderHook(() => useContentListFields("posts", undefined));
		expect(result.current).toBeUndefined();
	});

	it("asks for whole entries when a plugin adds a column to the collection", async () => {
		const pluginAdmins = {
			columns: {
				contentListColumns: [{ id: "score", label: "Score", cell: Cell, minRole: 50 }],
			},
		};
		expect(await listFields("posts", pluginAdmins)).toBeUndefined();
	});

	it("keeps asking for the shown fields when the plugin column is for another collection", async () => {
		const pluginAdmins = {
			columns: {
				contentListColumns: [{ id: "score", label: "Score", cell: Cell, collections: ["pages"] }],
			},
		};
		expect(await listFields("posts", pluginAdmins)).toEqual([
			"title",
			"name",
			"headline",
			"event_date",
			"rating",
		]);
	});
});
