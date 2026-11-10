import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { lazyRouteComponent, retryFailedScreens } from "../../src/lib/lazy-screen.js";
import { render } from "../utils/render.tsx";

class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? <p>Unavailable</p> : this.props.children;
	}
}

describe("lazy screen recovery", () => {
	it("surfaces an offline import failure without unloading the document, then retries", async () => {
		const importer = vi
			.fn()
			.mockRejectedValueOnce(
				new TypeError(
					"Failed to fetch dynamically imported module: https://example.test/screen.js",
				),
			)
			.mockResolvedValue({ Screen: () => <p>Recovered screen</p> });
		const Screen = lazyRouteComponent(importer, "Screen");
		await Screen.preload();
		const screen = await render(
			<Boundary>
				<React.Suspense>
					<Screen />
				</React.Suspense>
			</Boundary>,
		);
		await expect.element(screen.getByText("Unavailable")).toBeInTheDocument();
		retryFailedScreens();
		await Screen.preload();
		await screen.rerender(
			<Boundary key="retry">
				<React.Suspense>
					<Screen />
				</React.Suspense>
			</Boundary>,
		);
		await expect.element(screen.getByText("Recovered screen")).toBeInTheDocument();
	});
});
