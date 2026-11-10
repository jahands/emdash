import { screen } from "@testing-library/react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api/media.js", async () => {
	const actual =
		await vi.importActual<typeof import("../src/lib/api/media.js")>("../src/lib/api/media.js");
	return { ...actual, fetchMediaItem: vi.fn() };
});

import { ImageExtension } from "../src/components/editor/ImageNode.js";
import { fetchMediaItem, type LocalMediaItem } from "../src/lib/api/media.js";
import { render } from "./utils/render.js";

const MEDIA_ID = "01MEDIA";
const MEDIA_URL = "/_emdash/api/media/file/small-tools.jpg";

function TestEditor() {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		content: {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: MEDIA_URL,
						alt: "Workshop tools",
						mediaId: MEDIA_ID,
						provider: "local",
					},
				},
			],
		},
		immediatelyRender: true,
	});

	return editor ? <EditorContent editor={editor} /> : null;
}

describe("Editor image media refresh", () => {
	beforeEach(() => {
		vi.mocked(fetchMediaItem).mockReset();
	});

	it("renders the current bytes for a local media block", async () => {
		vi.mocked(fetchMediaItem).mockResolvedValue({
			id: MEDIA_ID,
			filename: "small-tools.jpg",
			mimeType: "image/jpeg",
			url: MEDIA_URL,
			storageKey: "small-tools.jpg",
			size: 1024,
			width: 467,
			height: 311,
			status: "ready",
			authorId: null,
			folderId: null,
			createdAt: "2026-09-03T10:00:00.000Z",
			contentHash: "sha1:cropped",
		} satisfies LocalMediaItem);

		void render(<TestEditor />);

		await screen.findByRole("img", { name: "Workshop tools" });
		await vi.waitFor(() => {
			const src = screen.getByRole("img", { name: "Workshop tools" }).getAttribute("src");
			expect(src).toBeTruthy();
			const url = new URL(src!, location.origin);
			expect(url.searchParams.get("href") || url.href).toBe(
				`${location.origin}${MEDIA_URL}?_emdash_media=sha1%3Acropped`,
			);
		});
		expect(screen.getByRole("img", { name: "Workshop tools" })).toHaveAttribute("width", "467");
		expect(screen.getByRole("img", { name: "Workshop tools" })).toHaveAttribute("height", "311");
		expect(fetchMediaItem).toHaveBeenCalledWith(MEDIA_ID, { signal: expect.any(AbortSignal) });
	});
});

it("does not request the stored image before media metadata resolves", async () => {
	vi.mocked(fetchMediaItem).mockImplementation(() => new Promise(() => {}));
	void render(<TestEditor />);
	const image = await screen.findByRole("img", { name: "Workshop tools" });
	expect(image.getAttribute("src")).toBeNull();
});

it("renders a stored URL when metadata fails, including images without dimensions", async () => {
	vi.mocked(fetchMediaItem).mockRejectedValue(new Error("Missing media"));
	void render(<TestEditor />);
	const image = await screen.findByRole("img", { name: "Workshop tools" });
	await vi.waitFor(() =>
		expect(screen.getByRole("img", { name: "Workshop tools" })).toHaveAttribute("src", MEDIA_URL),
	);
	expect(image.getAttribute("width")).toBeNull();
});
