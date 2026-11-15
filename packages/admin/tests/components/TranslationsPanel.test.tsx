import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { TranslationsPanel } from "../../src/components/TranslationsPanel";
import { render } from "../utils/render";

const LOCALES = ["en", "fr", "ar"];

function rowHeights(container: HTMLElement) {
	return Array.from(
		container.querySelectorAll<HTMLElement>(".space-y-2 > div"),
		(row) => row.getBoundingClientRect().height,
	);
}

describe("TranslationsPanel", () => {
	it("offers no Translate or Edit action while the translations load", async () => {
		const screen = await render(
			<TranslationsPanel
				locales={LOCALES}
				defaultLocale="en"
				currentLocale="en"
				translations={[]}
				loading
				onOpen={vi.fn()}
				onCreate={vi.fn()}
			/>,
		);

		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading translations...");
		expect(screen.getByRole("button").elements()).toHaveLength(0);
		await expect.element(screen.getByText("fr")).toBeVisible();
		await expect.element(screen.getByText("ar")).toBeVisible();
	});

	it("keeps each row's height when the translations arrive", async () => {
		const props = {
			locales: LOCALES,
			defaultLocale: "en",
			currentLocale: "en",
			onOpen: vi.fn(),
			onCreate: vi.fn(),
		};
		const screen = await render(
			<div style={{ width: 320 }}>
				<TranslationsPanel {...props} translations={[]} loading />
			</div>,
		);
		const loadingHeights = rowHeights(screen.container);

		await screen.rerender(
			<div style={{ width: 320 }}>
				<TranslationsPanel
					{...props}
					translations={[
						{ id: "en-1", locale: "en" },
						{ id: "fr-1", locale: "fr" },
					]}
				/>
			</div>,
		);

		await expect.element(screen.getByRole("button", { name: "Edit" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Translate" })).toBeVisible();
		expect(screen.getByRole("status").elements()).toHaveLength(0);
		expect(rowHeights(screen.container)).toEqual(loadingHeights);
	});

	it("treats an omitted loading prop as loaded", async () => {
		const screen = await render(
			<TranslationsPanel
				locales={LOCALES}
				defaultLocale="en"
				currentLocale="en"
				translations={[]}
				onCreate={vi.fn()}
			/>,
		);

		expect(screen.getByRole("button", { name: "Translate" }).elements()).toHaveLength(2);
	});
});
