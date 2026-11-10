import { cdp } from "vitest/browser";

/**
 * Presses a corner of the page with real mouse input, outside any dialog.
 * Base UI's outside-press dismissal ignores synthetic events.
 */
export async function pressOutside(corner: "top" | "bottom" = "top") {
	const session = cdp();
	// Mouse input lands in the top-level page, which hosts this test's frame.
	const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	// The top-level page can scroll a few pixels, which moves the frame's edges out of
	// its viewport, and presses outside the viewport reach nothing.
	const top = Math.max(frame.top, 0);
	const bottom = Math.min(frame.bottom, window.parent.innerHeight);
	const y = corner === "top" ? top + 4 : bottom - 4;
	for (const type of ["mousePressed", "mouseReleased"] as const) {
		await session.send("Input.dispatchMouseEvent", {
			type,
			x: Math.max(frame.left, 0) + 4,
			y,
			button: "left",
			clickCount: 1,
		});
	}
	// A dismissal has started by the time the test looks.
	await new Promise((resolve) => setTimeout(resolve, 300));
}
