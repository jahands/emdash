/**
 * Server-side strings come from small per-locale server catalogs. Each must
 * resolve exactly as it would from the locale's full admin catalog.
 */

import { describe, expect, test, vi } from "vitest";

import { SUPPORTED_LOCALES } from "../../src/locales/config.js";
import {
	getDomainMoveEmailStrings,
	getInviteEmailStrings,
	getMagicLinkEmailStrings,
} from "../../src/locales/emails.js";
import { loadMessages } from "../../src/locales/loadMessages.js";
import { loadServerMessages } from "../../src/locales/loadServerMessages.js";
import { loadAdminBootLabel, loadVisualEditingToolbarLabels } from "../../src/locales/server.js";

vi.mock("../../src/locales/loadServerMessages.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/locales/loadServerMessages.js")>();
	return { loadServerMessages: vi.fn(original.loadServerMessages) };
});

async function serverStrings(code: string) {
	const request = new Request("https://example.com/", {
		headers: { "accept-language": code },
	});
	return {
		toolbar: await loadVisualEditingToolbarLabels(request),
		bootLabel: await loadAdminBootLabel(code),
		invite: await getInviteEmailStrings(code, "Acme"),
		magicLink: await getMagicLinkEmailStrings(code, "Acme"),
		domainMove: await getDomainMoveEmailStrings(code, "Acme", "new.example.com"),
	};
}

describe("server catalogs", () => {
	const serverLoader = vi.mocked(loadServerMessages).getMockImplementation()!;

	test.each(SUPPORTED_LOCALES.map((locale) => locale.code))(
		"resolve the %s toolbar and email strings as the full catalog does",
		async (code) => {
			const actual = await serverStrings(code);

			vi.mocked(loadServerMessages).mockImplementation(loadMessages);
			try {
				const expected = await serverStrings(code);
				expect(actual).toEqual(expected);
			} finally {
				vi.mocked(loadServerMessages).mockImplementation(serverLoader);
			}
		},
	);

	test("carry translations, not only the English source", async () => {
		const { toolbar, bootLabel } = await serverStrings("ar");

		expect(toolbar.publish).not.toBe("Publish");
		expect(bootLabel).not.toBe("Loading");
	});
});
