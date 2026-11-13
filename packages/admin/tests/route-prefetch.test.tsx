import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminManifest } from "../src/lib/api";
import { setRoutePrefetchFiles } from "../src/lib/route-prefetch.js";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createMockFetch, createTestQueryClient } from "./utils/test-helpers";

const modules = vi.hoisted(() => {
	let releaseMedia!: () => void;
	const media = new Promise<void>((resolve) => {
		releaseMedia = resolve;
	});
	return { imported: [] as string[], media, releaseMedia };
});

vi.mock("../src/components/Shell", () => ({
	Shell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../src/components/Dashboard", () => ({
	Dashboard: () => <h1>Dashboard</h1>,
}));

vi.mock("../src/components/ContentList", () => {
	modules.imported.push("components/ContentList");
	return { ContentList: () => <h1>Posts</h1> };
});

vi.mock("../src/components/ContentEditor", () => {
	modules.imported.push("components/ContentEditor");
	return { ContentEditor: () => <div>Editor</div> };
});

vi.mock("../src/components/MediaLibrary", async () => {
	modules.imported.push("components/MediaLibrary");
	await modules.media;
	return { MediaLibrary: () => <h1>Media</h1> };
});

vi.mock("../src/components/Settings", () => {
	modules.imported.push("components/Settings");
	return { Settings: () => <h1>Settings</h1> };
});

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "abc123",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
			hasSeo: false,
			fields: { title: { kind: "string", label: "Title" } },
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const PREFETCH_FILES = {
	"components/ContentList": ["/_astro/ContentList.js", "/_astro/DataTable.js"],
	"components/ContentEditor": [
		"/_astro/ContentEditor.js",
		"/_astro/tiptap.js",
		"/_astro/lib.js",
		"/_astro/icons.js",
		"/_astro/purify.js",
	],
};

interface Download {
	url: string;
	signal: AbortSignal;
	finished: boolean;
	finish: () => void;
}

const nextTasks = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("downloading screens before they open", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;
	let mockedFetch: typeof fetch;
	let downloads: Download[];
	let releaseMe: () => void;
	let rendered: Awaited<ReturnType<typeof render>> | undefined;

	const pending = () => downloads.filter((d) => !d.signal.aborted && !d.finished);
	const pendingUrls = () => pending().map((d) => d.url);

	beforeEach(() => {
		downloads = [];
		mockFetch = createMockFetch();
		mockFetch
			.on("GET", "/_emdash/api/manifest", { data: MANIFEST })
			.on("GET", "/_emdash/api/auth/me", { data: { id: "user_01", role: 60 } })
			.on("GET", "/_emdash/api/content/posts/authors", { data: { items: [] } })
			.on("GET", "/_emdash/api/content/posts/trash", { data: { items: [], total: 0 } })
			.on("GET", "/_emdash/api/content/posts", { data: { items: [], total: 0 } })
			.on("GET", "/_emdash/api/media/folders", { data: { items: [] } })
			.on("GET", "/_emdash/api/media", { data: { items: [], totalCount: 0 } });
		const me = new Promise<void>((resolve) => {
			releaseMe = resolve;
		});
		mockedFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.startsWith("/_astro/")) {
				const signal = init?.signal ?? new AbortController().signal;
				return new Promise<Response>((resolve, reject) => {
					const download: Download = {
						url,
						signal,
						finished: false,
						finish: () => {
							download.finished = true;
							resolve(new Response("export {};"));
						},
					};
					downloads.push(download);
					signal.addEventListener("abort", () => reject(signal.reason));
				});
			}
			if (url === "/_emdash/api/auth/me") await me;
			return mockedFetch(input, init);
		}) as typeof fetch;
	});

	afterEach(async () => {
		await rendered?.unmount();
		releaseMe();
		globalThis.fetch = mockedFetch;
		mockFetch.restore();
		vi.restoreAllMocks();
	});

	async function openAdmin() {
		const queryClient = createTestQueryClient();
		const router = createAdminRouter(queryClient);
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		setRoutePrefetchFiles(PREFETCH_FILES);
		await router.navigate({ to: "/" });
		rendered = await render(
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>,
		);
		return { router, screen: rendered };
	}

	it("downloads nothing with Data Saver on", async () => {
		vi.spyOn(
			navigator as Navigator & { connection?: unknown },
			"connection",
			"get",
		).mockReturnValue({ saveData: true });
		releaseMe();
		const { screen } = await openAdmin();
		await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		await nextTasks();
		expect(downloads).toEqual([]);
	});

	it("downloads only the content list and editor, four files at a time, never while a screen loads", async () => {
		const { router, screen } = await openAdmin();
		await nextTasks();
		expect(downloads).toEqual([]);

		releaseMe();
		await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeVisible();
		await expect
			.poll(pendingUrls)
			.toEqual([
				"/_astro/ContentList.js",
				"/_astro/DataTable.js",
				"/_astro/ContentEditor.js",
				"/_astro/tiptap.js",
			]);

		// Opening the content list keeps the downloads of its own files and aborts the rest.
		void router.navigate({ to: "/content/$collection", params: { collection: "posts" } });
		await expect.poll(pendingUrls).toEqual(PREFETCH_FILES["components/ContentList"]);
		for (const download of pending()) download.finish();
		await expect.element(screen.getByRole("heading", { name: "Posts" })).toBeVisible();

		await expect
			.poll(pendingUrls)
			.toEqual([
				"/_astro/ContentEditor.js",
				"/_astro/tiptap.js",
				"/_astro/lib.js",
				"/_astro/icons.js",
			]);
		pending()[0]!.finish();
		await expect
			.poll(pendingUrls)
			.toEqual(["/_astro/tiptap.js", "/_astro/lib.js", "/_astro/icons.js", "/_astro/purify.js"]);

		// Opening a screen whose files aren't downloading aborts them all until it has loaded.
		const aborted = pending();
		void router.navigate({ to: "/media" });
		await expect.poll(() => aborted.every((d) => d.signal.aborted)).toBe(true);
		await nextTasks();
		expect(pending()).toEqual([]);

		modules.releaseMedia();
		await expect.element(screen.getByRole("heading", { name: "Media" })).toBeVisible();
		await expect
			.poll(pendingUrls)
			.toEqual(["/_astro/tiptap.js", "/_astro/lib.js", "/_astro/icons.js", "/_astro/purify.js"]);
		for (const download of pending()) download.finish();
		await expect.poll(() => modules.imported).toContain("components/ContentEditor");

		await nextTasks();
		const requested = downloads.map((d) => d.url);
		const finished = downloads.filter((d) => d.finished).map((d) => d.url);
		expect(new Set(requested)).toEqual(new Set(Object.values(PREFETCH_FILES).flat()));
		expect(finished.toSorted()).toEqual(Object.values(PREFETCH_FILES).flat().toSorted());
		expect(modules.imported).not.toContain("components/Settings");
	});
});
