import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AdminApp } from "../src/App.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import { createMockFetch } from "./utils/test-helpers.js";

const dateLocale = vi.hoisted(() => {
	let release!: () => void;
	const loaded = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { loaded, release };
});

vi.mock("react-day-picker/locale/ar", async (importOriginal) => {
	await dateLocale.loaded;
	return importOriginal();
});

vi.mock("../src/components/Shell.js", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("../src/components/Dashboard.js", () => ({
	Dashboard: () => <div>Dashboard content</div>,
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

describe("AdminApp boot for a locale with its own date locale", () => {
	const initialUrl = window.location.href;
	let mockFetch: ReturnType<typeof createMockFetch>;

	afterEach(() => {
		mockFetch.restore();
		window.history.replaceState(null, "", initialUrl);
	});

	it("requests the manifest while the date locale loads, and shows the admin once it has", async () => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 50 } });
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		window.history.replaceState(null, "", "/_emdash/admin/");

		const screen = await render(<AdminApp locale="ar" messages={{}} />);

		await expect
			.poll(() =>
				fetchSpy.mock.calls.some(([input]) =>
					(input instanceof Request ? input.url : input.toString()).includes(
						"/_emdash/api/manifest",
					),
				),
			)
			.toBe(true);
		await expect.element(screen.getByRole("status")).toBeInTheDocument();
		expect(screen.getByTestId("shell").query()).toBeNull();

		dateLocale.release();

		await expect.element(screen.getByText("Dashboard content")).toBeInTheDocument();
		fetchSpy.mockRestore();
	});
});
