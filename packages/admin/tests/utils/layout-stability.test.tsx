import * as React from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { expectStableLayout, measureLayoutShifts } from "./layout-stability";

const SKELETON_HEIGHT = 200;

function Panel({ loaded, skeletonHeight }: { loaded: boolean; skeletonHeight: number }) {
	return (
		<div style={{ width: 400 }}>
			<div style={{ height: loaded ? SKELETON_HEIGHT : skeletonHeight }}>
				{loaded ? "Loaded" : "Loading"}
			</div>
			<div data-testid="below">Content below</div>
		</div>
	);
}

describe("layout stability assertions", () => {
	it("passes when a loading state reserves the loaded height", async () => {
		const screen = await render(<Panel loaded={false} skeletonHeight={SKELETON_HEIGHT} />);
		await expectStableLayout(() =>
			screen.rerender(<Panel loaded skeletonHeight={SKELETON_HEIGHT} />),
		);
	});

	it("reports the element a too-short loading state pushes down", async () => {
		const screen = await render(<Panel loaded={false} skeletonHeight={40} />);
		const shifts = await measureLayoutShifts(() =>
			screen.rerender(<Panel loaded skeletonHeight={40} />),
		);
		expect(shifts.flatMap((shift) => shift.sources.map((source) => source.selector))).toContain(
			'[data-testid="below"]',
		);
	});

	it("fails when a too-short loading state shifts the content", async () => {
		const screen = await render(<Panel loaded={false} skeletonHeight={40} />);
		await expect(
			expectStableLayout(() => screen.rerender(<Panel loaded skeletonHeight={40} />)),
		).rejects.toThrow("layout shift");
	});
});
