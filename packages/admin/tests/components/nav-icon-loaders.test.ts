import { Acorn, PulseIcon } from "@phosphor-icons/react";
import { describe, expect, it } from "vitest";

import { loadNavIcon } from "../../src/lib/nav-icon-loaders.js";

describe("plugin navigation icon loading", () => {
	it("loads uncommon icons by their public names", async () => {
		expect(await loadNavIcon("Acorn")).toBe(Acorn);
	});

	it("preserves legacy public aliases", async () => {
		expect(await loadNavIcon("ActivityIcon")).toBe(PulseIcon);
	});

	it("leaves unknown and prototype names to the caller's fallback", async () => {
		for (const name of ["NotAnIcon", "constructor", "__proto__"]) {
			expect(await loadNavIcon(name)).toBeUndefined();
		}
	});
});
