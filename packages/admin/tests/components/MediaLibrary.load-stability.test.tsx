import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { MediaLibrary } from "../../src/components/MediaLibrary.js";
import type {
	MediaUsageActivationStatus,
	MediaUsageProgress,
} from "../../src/lib/api/media-usage-activation.js";
import type { MediaFolder, MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

const usage = vi.hoisted(() => ({
	fetchStatus: vi.fn(),
	fetchProgress: vi.fn(),
}));

vi.mock("../../src/lib/api/media-usage-activation.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api/media-usage-activation.js")>()),
	fetchMediaUsageActivationStatus: usage.fetchStatus,
	fetchMediaUsageProgress: usage.fetchProgress,
}));

vi.mock("../../src/lib/api", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api")>()),
	fetchMediaProviders: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "admin-1", role: 50 } }),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({
		children,
		to,
		params: _params,
		search: _search,
		...props
	}: React.ComponentProps<"a"> & { to?: string; params?: unknown; search?: unknown }) => (
		<a href={typeof to === "string" ? to : "#"} {...props}>
			{children}
		</a>
	),
}));

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const items: MediaItem[] = Array.from({ length: 12 }, (_, index) => ({
	id: `media-${index}`,
	filename: `document-${index}.txt`,
	mimeType: "text/plain",
	url: `/media/document-${index}.txt`,
	size: 1024,
	createdAt: "2026-01-01T00:00:00Z",
}));

const folders: MediaFolder[] = [
	{ id: "folder-1", name: "Campaign assets" },
	{ id: "folder-2", name: "Product photos" },
];

const activeStatus = { state: "active" } as MediaUsageActivationStatus;
const indexing: MediaUsageProgress = {
	status: "indexing",
	readyCollections: 1,
	totalCollections: 2,
};
const ready: MediaUsageProgress = { status: "ready", readyCollections: 2, totalCollections: 2 };

interface RouteState {
	items: MediaItem[];
	isLoading: boolean;
	folders: MediaFolder[];
	foldersLoading: boolean;
	foldersError: Error | null;
}

const loadingRoute: RouteState = {
	items: [],
	isLoading: true,
	folders: [],
	foldersLoading: true,
	foldersError: null,
};

function library(state: RouteState, dir: "ltr" | "rtl") {
	return (
		<Toasty>
			<main dir={dir} style={{ padding: 16 }}>
				<MediaLibrary
					items={state.items}
					isLoading={state.isLoading}
					pagination={{
						page: 1,
						perPage: 35,
						totalCount: state.items.length,
						isPending: state.isLoading,
						onPageChange: vi.fn(),
						onPageSizeChange: vi.fn(),
					}}
					folders={state.folders}
					foldersLoading={state.foldersLoading}
					foldersError={state.foldersError}
					onRetryFolders={vi.fn()}
					onOpenFolder={vi.fn()}
				/>
			</main>
		</Toasty>
	);
}

async function nextFrames() {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** Records where the persistent controls and the first asset are after each response. */
function positionLog() {
	const seen = new Map<string, { step: string; x: number; y: number }[]>();
	const targets: Record<string, () => Element | null> = {
		upload: () => document.querySelector("[data-media-library] button[aria-label='Upload Files']"),
		search: () => document.querySelector("input[aria-label='Search media']"),
		"type filter": () => document.querySelector("[aria-label='Filter by type']"),
		"first asset": () => document.querySelector("[data-media-grid] > *"),
	};
	return {
		async record(step: string) {
			await nextFrames();
			for (const [name, find] of Object.entries(targets)) {
				const element = find();
				if (!element) continue;
				const box = element.getBoundingClientRect();
				const entries = seen.get(name) ?? [];
				entries.push({ step, x: box.left, y: box.top });
				seen.set(name, entries);
			}
		},
		expectStable() {
			for (const name of Object.keys(targets)) {
				const entries = seen.get(name);
				expect(entries, `${name} never appeared`).toBeDefined();
				const first = entries![0]!;
				for (const entry of entries!) {
					expect(
						Math.abs(entry.y - first.y),
						`${name} moved vertically between "${first.step}" and "${entry.step}"`,
					).toBeLessThanOrEqual(1);
					expect(
						Math.abs(entry.x - first.x),
						`${name} moved horizontally between "${first.step}" and "${entry.step}"`,
					).toBeLessThanOrEqual(1);
				}
			}
		},
	};
}

let activation: Deferred<MediaUsageActivationStatus>;
let progress: Deferred<MediaUsageProgress>;

beforeEach(() => {
	activation = deferred();
	progress = deferred();
	usage.fetchStatus.mockReset().mockImplementation(() => activation.promise);
	usage.fetchProgress.mockReset().mockImplementation(() => progress.promise);
});

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Media Library loading stability", () => {
	it.each([
		{ viewport: "desktop", width: 1280, height: 800, dir: "ltr" },
		{ viewport: "phone", width: 390, height: 844, dir: "rtl" },
	] as const)(
		"keeps the controls and assets still while an indexing site with no folders loads ($viewport, $dir)",
		async ({ width, height, dir }) => {
			await page.viewport(width, height);
			const log = positionLog();
			const screen = await render(library(loadingRoute, dir));
			await log.record("first render");

			await vi.waitFor(() => expect(usage.fetchStatus).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(usage.fetchProgress).toHaveBeenCalledOnce());

			await screen.rerender(library({ ...loadingRoute, items, isLoading: false }, dir));
			await log.record("media list");
			await screen.rerender(
				library({ ...loadingRoute, items, isLoading: false, foldersLoading: false }, dir),
			);
			await log.record("empty folders");
			activation.resolve(activeStatus);
			await log.record("activation");
			progress.resolve(indexing);
			await log.record("progress");

			await expect
				.element(screen.getByText("Media usage tracking is indexing existing content"))
				.toBeVisible();
			await expect
				.element(screen.getByRole("link", { name: "View setup" }))
				.toHaveAttribute("href", "/settings/media-usage");
			expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
			await log.record("settled");
			log.expectStable();
		},
	);

	it("keeps the controls and assets still while folders arrive after the media list", async () => {
		const log = positionLog();
		const screen = await render(library(loadingRoute, "ltr"));
		await log.record("first render");

		activation.resolve(activeStatus);
		await log.record("activation");
		progress.resolve(indexing);
		await log.record("progress");
		await screen.rerender(library({ ...loadingRoute, items, isLoading: false }, "ltr"));
		await log.record("media list");
		await screen.rerender(
			library({ ...loadingRoute, items, isLoading: false, folders, foldersLoading: false }, "ltr"),
		);
		await log.record("folders");

		await expect.element(screen.getByRole("heading", { name: "Folders" })).toBeVisible();
		await expect
			.element(screen.getByRole("link", { name: "Open folder Product photos" }))
			.toBeVisible();
		await expect
			.element(screen.getByText("Media usage tracking is indexing existing content"))
			.toBeVisible();
		await log.record("settled");
		log.expectStable();
	});

	it("keeps the controls and assets still when indexing is finished and there are no folders", async () => {
		const log = positionLog();
		const screen = await render(library(loadingRoute, "ltr"));
		await log.record("first render");

		await screen.rerender(library({ ...loadingRoute, items, isLoading: false }, "ltr"));
		await log.record("media list");
		activation.resolve(activeStatus);
		await log.record("activation");
		progress.resolve(ready);
		await log.record("progress");
		await screen.rerender(
			library({ ...loadingRoute, items, isLoading: false, foldersLoading: false }, "ltr"),
		);
		await log.record("empty folders");

		await expect.element(screen.getByRole("button", { name: "Upload Files" })).toBeVisible();
		expect(screen.getByRole("link", { name: "View setup" }).query()).toBeNull();
		expect(screen.getByRole("heading", { name: "Folders" }).query()).toBeNull();
		await log.record("settled");
		log.expectStable();
	});

	it("keeps the controls and assets still when folders and indexing progress fail", async () => {
		const log = positionLog();
		const screen = await render(library(loadingRoute, "ltr"));
		await log.record("first render");

		await screen.rerender(library({ ...loadingRoute, items, isLoading: false }, "ltr"));
		await log.record("media list");
		await screen.rerender(
			library(
				{
					...loadingRoute,
					items,
					isLoading: false,
					foldersLoading: false,
					foldersError: new Error("offline"),
				},
				"ltr",
			),
		);
		await log.record("folders failed");
		activation.resolve(activeStatus);
		await log.record("activation");
		progress.reject(new Error("unavailable"));
		await log.record("progress failed");

		await expect.element(screen.getByText("Folders could not be loaded.")).toBeVisible();
		await expect.element(screen.getByText("Media usage tracking needs attention")).toBeVisible();
		await log.record("settled");
		log.expectStable();
	});
});
