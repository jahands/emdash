import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdminRouter } from "../../src/router.js";

afterEach(() => vi.restoreAllMocks());

describe("admin route preloading", () => {
	it("starts dashboard data before the manifest resolves and reuses the query cache", async () => {
		const requests: string[] = [];
		let releaseManifest!: () => void;
		const ready = new Promise<void>((resolve) => {
			releaseManifest = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			requests.push(url);
			if (url.endsWith("/manifest")) await ready;
			return Response.json({ success: true, data: {} });
		});
		const queryClient = new QueryClient({
			defaultOptions: { queries: { staleTime: 60_000, retry: false } },
		});
		const router = createAdminRouter(queryClient);
		try {
			const preload = router.preloadRoute({ to: "/" });
			await vi.waitFor(
				() => {
					expect(requests.some((url) => url.endsWith("/manifest"))).toBe(true);
					expect(requests.some((url) => url.endsWith("/dashboard"))).toBe(true);
					expect(requests.some((url) => url.endsWith("/auth/me"))).toBe(true);
				},
				{ timeout: 5000 },
			);
			releaseManifest();
			await preload;
			const count = requests.length;
			await router.preloadRoute({ to: "/" });
			expect(requests).toHaveLength(count);
		} finally {
			releaseManifest();
			queryClient.clear();
		}
	});
	it("does not fetch authenticated data while preloading sign-in", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const router = createAdminRouter(queryClient);
		try {
			await router.preloadRoute({ to: "/login" });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			queryClient.clear();
		}
	});
});
