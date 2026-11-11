import { screen } from "@testing-library/react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImageExtension } from "../src/components/editor/ImageNode.js";
import { ImageFieldRenderer } from "../src/components/ImageFieldRenderer.js";
import { MediaBrowserItem } from "../src/components/media/MediaBrowserItems.js";
import type { LocalMediaItem } from "../src/lib/api/media.js";
import { render } from "./utils/render.js";

import "../dist/styles.css";

const IMAGE_COUNT = 12;

function mediaItem(index: number): LocalMediaItem {
	return {
		id: `01MEDIA${index}`,
		filename: `photo-${index}.jpg`,
		mimeType: "image/jpeg",
		url: `/_emdash/api/media/file/photo-${index}.jpg`,
		storageKey: `photo-${index}.jpg`,
		size: 3_000_000,
		width: 4000,
		height: 3000,
		status: "ready",
		authorId: null,
		folderId: null,
		createdAt: "2026-11-01T10:00:00.000Z",
		contentHash: `sha1:hash${index}`,
	};
}

function LongEntryEditor() {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		content: {
			type: "doc",
			content: Array.from({ length: IMAGE_COUNT }, (_, index) => ({
				type: "image",
				attrs: {
					src: `/_emdash/api/media/file/photo-${index}.jpg`,
					alt: `Photo ${index}`,
					mediaId: `01MEDIA${index}`,
					provider: "local",
					width: 4000,
					height: 3000,
				},
			})),
		},
		immediatelyRender: true,
	});
	return editor ? <EditorContent editor={editor} /> : null;
}

/** The rendition width an image URL asks for, or null for a URL that isn't a rendition. */
function requestedWidth(src: string): number | null {
	const url = new URL(src, window.location.origin);
	if (url.pathname !== "/_image") return null;
	return Number(url.searchParams.get("w"));
}

function renditionSource(src: string): string | null {
	const href = new URL(src, window.location.origin).searchParams.get("href");
	return href ? new URL(href).pathname + new URL(href).search : null;
}

describe("admin image renditions", () => {
	let metadataRequests: string[][];
	let srcWrites: Map<Element, string[]>;

	beforeEach(() => {
		metadataRequests = [];
		srcWrites = new Map();
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(2);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string) => {
				const url = new URL(input, window.location.origin);
				if (url.pathname === "/_emdash/api/media" && url.searchParams.has("ids")) {
					const ids = url.searchParams.get("ids")!.split(",");
					metadataRequests.push(ids);
					const items = Array.from({ length: IMAGE_COUNT }, (_, index) => mediaItem(index)).filter(
						(item) => ids.includes(item.id),
					);
					return Response.json({ data: { items } });
				}
				return new Response(null, { status: 404 });
			}),
		);
		const setAttribute = Element.prototype.setAttribute;
		vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
			this: Element,
			name: string,
			value: string,
		) {
			if (this instanceof HTMLImageElement && name === "src") {
				srcWrites.set(this, [...(srcWrites.get(this) ?? []), value]);
			}
			setAttribute.call(this, name, value);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("requests each editor image once, as a rendition sized to its box, after one metadata request", async () => {
		const featured = mediaItem(0);
		void render(
			<div style={{ width: 600 }}>
				<ImageFieldRenderer
					label="Featured image"
					variant="featured"
					value={{
						id: featured.id,
						provider: "local",
						mimeType: featured.mimeType,
						width: featured.width,
						height: featured.height,
						meta: { storageKey: featured.storageKey },
					}}
					onChange={() => {}}
				/>
				<LongEntryEditor />
			</div>,
		);

		await vi.waitFor(() =>
			expect(screen.getAllByRole("img", { name: /^Photo \d+$/ })).toHaveLength(IMAGE_COUNT),
		);
		const bodyImages = screen.getAllByRole("img", { name: /^Photo \d+$/ });
		await vi.waitFor(() => {
			for (const image of bodyImages) expect(image).toHaveAttribute("src");
		});
		const images = [...document.querySelectorAll("img")];
		await vi.waitFor(() => {
			for (const image of images) expect(image).toHaveAttribute("src");
		});

		expect(metadataRequests).toHaveLength(1);
		expect(new Set(metadataRequests[0])).toEqual(
			new Set(Array.from({ length: IMAGE_COUNT }, (_, index) => `01MEDIA${index}`)),
		);

		for (const image of images) {
			const writes = srcWrites.get(image) ?? [];
			expect(writes).toHaveLength(1);
			const src = writes[0]!;
			const width = requestedWidth(src);
			expect(width).not.toBeNull();
			const box = Math.max(image.offsetWidth, (image.offsetHeight * 4000) / 3000);
			expect(width).toBeGreaterThanOrEqual(box * 2);
			expect(width).toBeLessThanOrEqual(box * 2 * 2);
			expect(renditionSource(src)).toMatch(
				/^\/_emdash\/api\/media\/file\/photo-\d+\.jpg\?_emdash_media=sha1%3Ahash\d+$/,
			);
		}
		for (const image of bodyImages) expect(image).toHaveAttribute("loading", "lazy");
	});

	it("sizes a phone grid thumbnail to its cell at the screen's pixel ratio", async () => {
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
		const item = mediaItem(1);
		void render(
			<div style={{ width: 342 }}>
				<MediaBrowserItem item={item} layout="grid" />
			</div>,
		);

		const image = await screen.findByRole("img", { name: item.filename });
		await vi.waitFor(() => expect(image).toHaveAttribute("src"));
		const width = requestedWidth(image.getAttribute("src")!);
		const needed = Math.max(image.offsetWidth, (image.offsetHeight * 4000) / 3000) * 3;
		expect(needed).toBeGreaterThanOrEqual(1000);
		expect(width).toBeGreaterThanOrEqual(needed);
		expect(width).toBeLessThanOrEqual(needed * 2);
	});

	it("sizes a list row thumbnail to its box at the screen's pixel ratio", async () => {
		vi.spyOn(window, "devicePixelRatio", "get").mockReturnValue(3);
		const item = mediaItem(2);
		void render(<MediaBrowserItem item={item} layout="list" />);

		const image = await screen.findByRole("img", { name: item.filename });
		await vi.waitFor(() => expect(image).toHaveAttribute("src"));
		const width = requestedWidth(image.getAttribute("src")!);
		const needed = Math.max(image.offsetWidth, (image.offsetHeight * 4000) / 3000) * 3;
		expect(width).toBeGreaterThanOrEqual(needed);
		expect(width).toBeLessThanOrEqual(needed * 2);
	});
});
