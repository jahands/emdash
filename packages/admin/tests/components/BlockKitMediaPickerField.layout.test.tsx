import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { BlockKitMediaPickerField } from "../../src/components/BlockKitMediaPickerField";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));

describe("BlockKitMediaPickerField layout", () => {
	it("keeps the preview one height while the image loads and after it fails", async () => {
		const screen = await render(
			<div style={{ width: 320 }}>
				<BlockKitMediaPickerField
					actionId="hero"
					label="Hero"
					value="/_emdash/api/media/file/missing.png"
					onChange={vi.fn()}
				/>
			</div>,
		);
		const preview = () =>
			document.querySelector("img") ??
			screen.getByText("Image not found").element().closest("div.flex");

		await vi.waitFor(() => expect(preview()).toBeTruthy());
		expect(preview()!.getBoundingClientRect().height).toBe(160);

		document.querySelector("img")?.dispatchEvent(new Event("error"));
		await expect.element(screen.getByText("Image not found")).toBeVisible();
		expect(preview()!.getBoundingClientRect().height).toBe(160);
	});
});
