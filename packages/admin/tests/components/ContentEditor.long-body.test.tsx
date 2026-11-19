import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor";
import type { ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, search: _search, ...props }: any) => <a {...props}>{children}</a>,
		useBlocker: () => ({ status: "idle" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
		fetchReferenceChildren: vi.fn(async () => ({ children: [] })),
	};
});

const fields: Record<string, FieldDescriptor> = {
	title: { kind: "string", label: "Title", required: true },
	content: { kind: "portableText", label: "Content" },
};

function makeItem(): ContentItem {
	return {
		id: "item-1",
		type: "posts",
		slug: "long-post",
		status: "draft",
		data: {
			title: "Long post",
			content: Array.from({ length: 150 }, (_, index) => ({
				_type: "block",
				_key: `block-${index}`,
				style: "normal",
				children: [{ _type: "span", _key: `span-${index}`, text: `Paragraph ${index}` }],
			})),
		},
		authorId: null,
		createdAt: "2025-01-15T10:30:00Z",
		updatedAt: "2025-01-15T10:30:00Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
}

async function renderEditor(props: Partial<ContentEditorProps>) {
	const screen = await render(
		<ContentEditor
			collection="posts"
			collectionLabel="Post"
			fields={fields}
			isNew={false}
			item={makeItem()}
			onSave={vi.fn()}
			{...props}
		/>,
	);
	let editor: Editor | undefined;
	await vi.waitFor(() => {
		editor = (document.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null)
			?.editor;
		expect(editor).toBeTruthy();
	});
	return { screen, editor: editor! };
}

/** Types at the end of the first paragraph, the way ProseMirror applies keystrokes. */
function type(editor: Editor, text: string) {
	for (const char of text) {
		const end = editor.state.doc.firstChild!.nodeSize - 1;
		editor.view.dispatch(editor.state.tr.insertText(char, end));
	}
}

function saveButton(screen: Awaited<ReturnType<typeof render>>): HTMLElement {
	return screen.getByRole("button", { name: "Save" }).first().element() as HTMLElement;
}

function savedBlocks(save: ReturnType<typeof vi.fn>): unknown[] {
	const payload = save.mock.lastCall![0] as { data: { content: unknown[] } };
	return payload.data.content;
}

function savedFirstParagraph(save: ReturnType<typeof vi.fn>): string {
	const block = savedBlocks(save)[0] as { children: Array<{ text: string }> };
	return block.children.map((span) => span.text).join("");
}

describe("ContentEditor with a long rich text body", () => {
	it("saves text typed right before Save is pressed", async () => {
		const onSave = vi.fn();
		const { screen, editor } = await renderEditor({ onSave });

		await React.act(async () => type(editor, " and more"));
		await React.act(async () => saveButton(screen).click());

		expect(onSave).toHaveBeenCalledTimes(1);
		expect(savedFirstParagraph(onSave)).toBe("Paragraph 0 and more");
		expect(savedBlocks(onSave)).toHaveLength(150);
	});

	it("autosaves everything typed once typing pauses", async () => {
		vi.useFakeTimers();
		try {
			const onAutosave = vi.fn();
			const { editor } = await renderEditor({ onAutosave });

			await React.act(async () => type(editor, " one"));
			await vi.advanceTimersByTimeAsync(1000);
			await React.act(async () => type(editor, " two"));
			await vi.advanceTimersByTimeAsync(1999);
			expect(onAutosave).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(onAutosave).toHaveBeenCalledTimes(1);
			expect(savedFirstParagraph(onAutosave)).toBe("Paragraph 0 one two");
		} finally {
			vi.useRealTimers();
		}
	});

	it("saves what undo and redo leave in the editor", async () => {
		const onSave = vi.fn();
		const { screen, editor } = await renderEditor({ onSave });

		await React.act(async () => {
			type(editor, " typed");
			editor.commands.undo();
		});
		await React.act(async () => editor.commands.redo());
		await React.act(async () => saveButton(screen).click());

		expect(savedFirstParagraph(onSave)).toBe("Paragraph 0 typed");
	});
});
