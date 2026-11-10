import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { MediaUploadDialog } from "../../src/components/MediaUploadDialog.js";
import { render } from "../utils/render.tsx";

function pdf(name: string) {
	return new File([name], name, { type: "application/pdf" });
}

function dialog(enqueueRequest: { id: number; files: File[] } | null, upload: () => Promise<void>) {
	return (
		<MediaUploadDialog
			open
			providerName="Library"
			enqueueRequest={enqueueRequest}
			onEnqueueRequestConsumed={vi.fn()}
			onOpenChange={vi.fn()}
			onCloseComplete={vi.fn()}
			upload={upload}
		/>
	);
}

function box(element: Element) {
	const { left, top, width } = element.getBoundingClientRect();
	return { left: Math.round(left), top: Math.round(top), width: Math.round(width) };
}

describe("MediaUploadDialog layout", () => {
	it.each([
		[1440, 900],
		[390, 844],
	])("keeps its title in place as files are added at %ix%i", async (width, height) => {
		await page.viewport(width, height);
		const upload = () => new Promise<void>(() => {});
		const screen = await render(dialog(null, upload));
		const title = screen.getByRole("heading", { name: "Upload to Library" });
		await expect.element(title).toBeVisible();
		const before = box(title.element());

		await screen.rerender(
			dialog({ id: 1, files: [pdf("one.pdf"), pdf("two.pdf"), pdf("three.pdf")] }, upload),
		);
		await expect.element(screen.getByText("three.pdf")).toBeVisible();
		expect(box(title.element())).toEqual(before);
	});

	it("keeps the footer buttons in place when the last upload finishes", async () => {
		await page.viewport(390, 844);
		const pending: Array<() => void> = [];
		const upload = () =>
			new Promise<void>((resolve) => {
				pending.push(resolve);
			});
		const screen = await render(dialog({ id: 1, files: [pdf("one.pdf"), pdf("two.pdf")] }, upload));
		await vi.waitFor(() => expect(pending).toHaveLength(2));

		pending[0]!();
		const clear = screen.getByRole("button", { name: "Clear completed" });
		await expect.element(clear).toBeVisible();
		const before = box(clear.element());

		pending[1]!();
		await expect.element(screen.getByRole("button", { name: "Done" })).toBeVisible();
		expect(box(clear.element())).toEqual(before);
		expect(screen.getByRole("button", { name: "Cancel remaining" }).query()).toBeNull();
	});
});
