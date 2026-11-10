import { describe, expect, it } from "vitest";

import { parseContentListSearch } from "../src/lib/content-list-search";
import { parseBylinesLocaleSearch } from "../src/router";

describe("parseBylinesLocaleSearch", () => {
	it("returns the locale string when present and non-empty", () => {
		expect(parseBylinesLocaleSearch({ locale: "de-de" })).toEqual({ locale: "de-de" });
	});

	it("normalizes empty-string locale to undefined", () => {
		// `/bylines?locale=` would otherwise leave `locale: ""` in route state.
		// The bylines API client treats empty string as truthy-omit, so the
		// page would fetch every locale's rows while UI says one is active.
		expect(parseBylinesLocaleSearch({ locale: "" })).toEqual({ locale: undefined });
	});

	it("returns undefined when locale is missing entirely", () => {
		expect(parseBylinesLocaleSearch({})).toEqual({ locale: undefined });
	});

	it("returns undefined when locale is not a string", () => {
		expect(parseBylinesLocaleSearch({ locale: 42 })).toEqual({ locale: undefined });
		expect(parseBylinesLocaleSearch({ locale: null })).toEqual({ locale: undefined });
	});
});

describe("parseContentListSearch", () => {
	it("keeps a valid page and page size", () => {
		expect(parseContentListSearch({ locale: "fr", page: 3, perPage: 50 })).toEqual({
			locale: "fr",
			page: 3,
			perPage: 50,
		});
	});

	it("ignores a page or page size that isn't a positive integer", () => {
		expect(parseContentListSearch({ page: "two", perPage: -1 })).toEqual({
			locale: undefined,
			page: undefined,
			perPage: undefined,
		});
		expect(parseContentListSearch({ page: 1.5 }).page).toBeUndefined();
	});

	it("reads an existing locale-only URL as page 1", () => {
		expect(parseContentListSearch({ locale: "de" })).toEqual({
			locale: "de",
			page: undefined,
			perPage: undefined,
		});
	});
});
