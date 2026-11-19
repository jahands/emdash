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
		const image = await vi.waitFor(() => {
			const found = document.querySelector("img");
			expect(found).toBeTruthy();
			return found!;
		});
		const frame = image.parentElement!;
		const size = () => {
			const { width, height } = frame.getBoundingClientRect();
			return { width, height };
		};
		const loading = size();
		expect(loading.height).toBe(64);

		image.dispatchEvent(new Event("error"));
		await expect.element(screen.getByText("Image not found")).toBeVisible();
		expect(frame.isConnected).toBe(true);
		expect(size()).toEqual(loading);
	});
});
