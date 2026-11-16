import { i18n } from "@lingui/core";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { ChangedElsewhereNotice } from "../../src/components/ChangedElsewhereNotice";
import { loadMessages } from "../../src/locales/loadMessages";
import { render } from "../utils/render";

afterEach(async () => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
	await page.viewport(1280, 800);
});

describe("ChangedElsewhereNotice", () => {
	it.each([
		{ name: "desktop", width: 1280 },
		{ name: "phone", width: 390 },
	])(
		"keeps its action inside the notice, at the inline end, in Arabic on $name",
		async ({ width }) => {
			await page.viewport(width, 800);
			i18n.loadAndActivate({ locale: "ar", messages: await loadMessages("ar") });
			const screen = await render(
				<div dir="rtl" lang="ar" style={{ padding: 16 }}>
					<ChangedElsewhereNotice onLoad={async () => undefined} />
				</div>,
			);
			const notice = screen.getByRole("status");
			await expect.element(notice).toBeVisible();
			const box = notice.element().getBoundingClientRect();
			const action = screen.getByRole("button").element().getBoundingClientRect();

			expect(action.left).toBeGreaterThanOrEqual(box.left);
			expect(action.right).toBeLessThanOrEqual(box.right);
			// In right-to-left text the inline end is the left edge.
			expect(action.left - box.left).toBeLessThan(box.right - action.right);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
		},
	);
});
