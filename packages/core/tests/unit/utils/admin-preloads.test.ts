import { describe, expect, it } from "vitest";

import { adminPreloadHrefs } from "../../../src/utils/admin-preloads.js";

const json = JSON.stringify({
	boot: ["/_astro/PluginRegistry.js", "/_astro/admin.js"],
	routes: {
		"components/ContentEditor": ["/_astro/ContentEditor.js", "/_astro/tiptap.js"],
		"components/ContentList": ["/_astro/ContentList.js"],
		"components/Dashboard": ["/_astro/Dashboard.js"],
	},
});

describe("adminPreloadHrefs", () => {
	it("preloads the boot files and the modules of the requested route", () => {
		expect(adminPreloadHrefs(json, "/_emdash/admin/content/posts/01ABC")).toEqual([
			"/_astro/PluginRegistry.js",
			"/_astro/admin.js",
			"/_astro/ContentEditor.js",
			"/_astro/tiptap.js",
		]);
		expect(adminPreloadHrefs(json, "/_emdash/admin/content/posts")).toEqual([
			"/_astro/PluginRegistry.js",
			"/_astro/admin.js",
			"/_astro/ContentList.js",
		]);
	});

	it("treats the admin root as the dashboard", () => {
		for (const pathname of ["/_emdash/admin", "/_emdash/admin/"]) {
			expect(adminPreloadHrefs(json, pathname)).toContain("/_astro/Dashboard.js");
		}
	});

	it("preloads only the boot files for a route without modules", () => {
		expect(adminPreloadHrefs(json, "/_emdash/admin/no/such/screen")).toEqual([
			"/_astro/PluginRegistry.js",
			"/_astro/admin.js",
		]);
	});

	it("preloads nothing when the build recorded nothing", () => {
		expect(adminPreloadHrefs("", "/_emdash/admin/")).toEqual([]);
		expect(adminPreloadHrefs("__EMDASH_ADMIN_PRELOADS__", "/_emdash/admin/")).toEqual([]);
	});
});
