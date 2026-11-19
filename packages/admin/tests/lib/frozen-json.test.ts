import { describe, expect, it } from "vitest";

import { freezeJson, isFrozenJson, stringifyJson } from "../../src/lib/frozen-json";

const block = (text: string) => ({
	_type: "block",
	_key: text,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${text}-span`, text, marks: ["strong"] }],
});

describe("stringifyJson", () => {
	it.each([
		["a string", "text"],
		["a number", 3],
		["null", null],
		["undefined", undefined],
		["an object", { a: 1, skipped: undefined, nested: { b: [1, "two"] } }],
		["a list with holes JSON writes as null", [1, undefined, () => {}, { a: undefined }]],
		["nested lists", [[1, [2]], []]],
		["frozen blocks in an unfrozen list", [freezeJson(block("one")), block("two")]],
		["a frozen list", freezeJson([block("one"), [block("two")]])],
	])("writes the same text as JSON.stringify for %s", (_label, value) => {
		expect(stringifyJson(value)).toBe(JSON.stringify(value));
	});
});

describe("freezeJson", () => {
	it("freezes nested values so the cached text can't go stale", () => {
		const value = freezeJson(block("one"));

		expect(isFrozenJson(value)).toBe(true);
		expect(isFrozenJson(value.children[0])).toBe(true);
		expect(() => {
			(value.children[0] as { text: string }).text = "changed";
		}).toThrow(TypeError);
	});

	it("doesn't treat values frozen elsewhere as safe to cache", () => {
		expect(isFrozenJson(Object.freeze({ a: [1] }))).toBe(false);
	});
});
