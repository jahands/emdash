import * as icons from "@phosphor-icons/react/ssr";
import { describe, expect, it } from "vitest";

import { PHOSPHOR_ICON_NAMES } from "../../src/components/phosphor-icon-names";

describe("the Phosphor icon name list", () => {
	it("matches the installed icon set (run scripts/generate-phosphor-icon-names.js after an upgrade)", () => {
		const exports = new Set(Object.keys(icons));
		const installed = [...exports].filter((name) => exports.has(`${name}Icon`)).toSorted();
		expect([...PHOSPHOR_ICON_NAMES].toSorted()).toEqual(installed);
	});
});
