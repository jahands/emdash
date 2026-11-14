import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AdminApp } from "../src/App.js";
import { apiFetch } from "../src/lib/api/client.js";
import { fetchCommentCounts } from "../src/lib/api/comments.js";
import type { AdminManifest } from "../src/lib/api/index.js";
import { createMockFetch } from "./utils/test-helpers.js";

vi.mock("../src/components/Shell.js", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

vi.mock("../src/components/Dashboard.js", () => ({
	Dashboard: () => {
		const { data: counts } = useQuery({ queryKey: ["commentCounts"], queryFn: fetchCommentCounts });
		const [probe, setProbe] = React.useState(false);
		React.useEffect(() => {
			if (probe) void apiFetch("/_emdash/api/forbidden-probe");
		}, [probe]);
		return (
			<>
				<button type="button" onClick={() => setProbe(true)}>
					Dashboard content
				</button>
				<p>{`${counts?.pending ?? "?"} pending`}</p>
			</>
		);
	},
}));

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function requested(spy: ReturnType<typeof vi.spyOn>, path: string): number {
	return spy.mock.calls.filter(([input]) =>
		(input instanceof Request ? input.url : String(input)).includes(path),
	).length;
}

describe("AdminApp with the data the admin page embedded", () => {
	const initialUrl = window.location.href;
	let mockFetch: ReturnType<typeof createMockFetch>;

	afterEach(() => {
		mockFetch.restore();
		window.history.replaceState(null, "", initialUrl);
	});

	it("shows the first screen without fetching the manifest, the user or the comment counts, and refetches the user when asked", async () => {
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", email: "a@b.c", role: 30 } })
			.on("GET", "/_emdash/api/forbidden-probe", { error: { code: "FORBIDDEN" } }, 403);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		window.history.replaceState(null, "", "/_emdash/admin/");

		const screen = await render(
			<AdminApp
				locale="en"
				messages={{}}
				initialData={{
					manifest: MANIFEST,
					currentUser: { id: "user_01", email: "a@b.c", role: 50 },
					commentCounts: { pending: 3, approved: 0, spam: 0, trash: 0 },
				}}
			/>,
		);

		await expect.element(screen.getByText("Dashboard content")).toBeInTheDocument();
		expect(requested(fetchSpy, "/_emdash/api/manifest")).toBe(0);
		expect(requested(fetchSpy, "/_emdash/api/auth/me")).toBe(0);
		await expect.element(screen.getByText("3 pending")).toBeInTheDocument();
		expect(requested(fetchSpy, "/_emdash/api/admin/comments/counts")).toBe(0);

		await screen.getByText("Dashboard content").click();
		await expect.poll(() => requested(fetchSpy, "/_emdash/api/auth/me")).toBe(1);
		fetchSpy.mockRestore();
	});
});
