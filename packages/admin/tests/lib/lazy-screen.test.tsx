import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";

import { lazyRouteComponent, retryFailedScreens } from "../../src/lib/lazy-screen.js";
import { reloadPage } from "../../src/lib/page-reload.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/page-reload.js", () => ({ reloadPage: vi.fn() }));

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

describe("lazy screen reload for a missing deployment chunk", () => {
	beforeEach(() => {
		vi.mocked(reloadPage).mockClear();
	});

	it("waits for pending saves before reloading", async () => {
		const chunk = `${location.origin}/__test/missing-chunk/screen-${Date.now()}.js`;
		const Screen = lazyRouteComponent(
			() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${chunk}`)),
			"Screen",
		);
		const queryClient = new QueryClient();
		let finishSave!: () => void;
		void queryClient
			.getMutationCache()
			.build(queryClient, {
				mutationFn: () =>
					new Promise<void>((resolve) => {
						finishSave = resolve;
					}),
			})
			.execute(undefined);
		await Screen.preload();

		const screen = await render(
			<QueryClientProvider client={queryClient}>
				<Boundary>
					<React.Suspense fallback={<p>Loading screen</p>}>
						<Screen />
					</React.Suspense>
				</Boundary>
			</QueryClientProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(reloadPage).not.toHaveBeenCalled();
		await expect.element(screen.getByText("Loading screen")).toBeInTheDocument();

		finishSave();
		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
		expect(screen.getByText("Unavailable").query()).toBeNull();
	});

	it("keeps waiting for a save queued behind the one in flight", async () => {
		const chunk = `${location.origin}/__test/missing-chunk/queued-${Date.now()}.js`;
		const Screen = lazyRouteComponent(
			() => Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${chunk}`)),
			"Screen",
		);
		const queryClient = new QueryClient();
		const saves: Array<() => void> = [];
		const save = () =>
			queryClient
				.getMutationCache()
				.build(queryClient, {
					mutationFn: () =>
						new Promise<void>((resolve) => {
							saves.push(resolve);
						}),
				})
				.execute(undefined);
		void save().then(() => save());
		await Screen.preload();

		await render(
			<QueryClientProvider client={queryClient}>
				<React.Suspense fallback={<p>Loading screen</p>}>
					<Screen />
				</React.Suspense>
			</QueryClientProvider>,
		);
		saves[0]!();
		await vi.waitFor(() => expect(saves).toHaveLength(2));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(reloadPage).not.toHaveBeenCalled();

		saves[1]!();
		await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
	});
});
