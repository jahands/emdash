import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { ADMIN_BOOT_DATA_ID } from "../../../src/api/admin-boot-id.js";
import {
	adminBootDataScript,
	loadAdminBootData,
	type AdminBootData,
} from "../../../src/api/admin-boot.js";

function bootData(label: string): AdminBootData {
	return {
		manifest: {
			version: "1.0.0",
			hash: "h",
			collections: {
				posts: { label, labelSingular: label, supports: [], hasSeo: false, fields: {} },
			},
			plugins: {},
			taxonomies: [],
			authMode: "passkey",
			siteTitle: label,
		} as unknown as AdminBootData["manifest"],
		currentUser: {
			id: "u1",
			email: "a@example.com",
			name: label,
			role: 50,
			avatarUrl: null,
			isFirstLogin: false,
			adminLayout: null,
		},
	};
}

describe("adminBootDataScript", () => {
	it("keeps user-provided text inside its JSON script element", () => {
		const label = "</script><script>window.pwned = 1</script><!-- &    </SCRIPT >";
		const data = bootData(label);
		const dom = new JSDOM(
			`<!doctype html><body>${adminBootDataScript(data)}<p id="after"></p></body>`,
		);
		const { document } = dom.window;

		expect(document.querySelectorAll("script")).toHaveLength(1);
		expect(document.getElementById("after")).not.toBeNull();
		const element = document.getElementById(ADMIN_BOOT_DATA_ID);
		expect(element?.getAttribute("type")).toBe("application/json");
		expect(JSON.parse(element?.textContent ?? "")).toEqual(data);
	});

	it("embeds nothing without boot data", () => {
		expect(adminBootDataScript(null)).toBe("");
	});
});

describe("loadAdminBootData", () => {
	it("returns nothing for an anonymous request off the login page without reading anything", async () => {
		const emdash = new Proxy(
			{},
			{
				get() {
					throw new Error("anonymous boot data must not touch the runtime");
				},
			},
		);
		await expect(loadAdminBootData({ emdash } as never, "/signup")).resolves.toBeNull();
	});
});
