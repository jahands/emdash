import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

type Blocks = NonNullable<React.ComponentProps<typeof PortableTextEditor>["value"]>;

function paragraphs(count: number): Blocks {
	return Array.from({ length: count }, (_, index) => ({
		_type: "block",
		_key: `block-${index}`,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `span-${index}`, text: `Paragraph ${index}`, marks: [] }],
	}));
}

/** Keeps the reported value in state and passes it back, as ContentEditor does. */
function Host({
	initial,
	onValue,
	onEditor,
}: {
	initial: Blocks;
	onValue: (value: Blocks) => void;
	onEditor: (editor: Editor | null) => void;
}) {
	const [value, setValue] = React.useState(initial);
	const handleChange = React.useCallback(
		(next: Blocks) => {
			setValue(next);
			onValue(next);
		},
		[onValue],
	);
	return <PortableTextEditor value={value} onChange={handleChange} onEditorReady={onEditor} />;
}

async function renderHost(initial: Blocks) {
	const values: Blocks[] = [];
	let editor: Editor | null = null;
	await render(
		<Host
			initial={initial}
			onValue={(value) => values.push(value)}
			onEditor={(instance) => {
				editor = instance;
			}}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	return { editor: editor!, values };
}

async function focusEditor(editor: Editor) {
	await React.act(async () => {
		editor.commands.focus();
	});
	await vi.waitFor(() => expect(editor.isFocused).toBe(true));
}

async function typeAtEndOfFirstParagraph(editor: Editor, text: string) {
	await React.act(async () => {
		for (const char of text) {
			const end = editor.state.doc.firstChild!.nodeSize - 1;
			editor.view.dispatch(editor.state.tr.insertText(char, end));
		}
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("typing in a long document", () => {
	it("converts only the block a keystroke changed", async () => {
		const { editor } = await renderHost(paragraphs(200));
		await typeAtEndOfFirstParagraph(editor, "a");

		const converted = new Set<ProseMirrorNode>();
		const toJSON = ProseMirrorNode.prototype.toJSON;
		vi.spyOn(ProseMirrorNode.prototype, "toJSON").mockImplementation(
			function (this: ProseMirrorNode) {
				converted.add(this);
				return toJSON.call(this);
			},
		);
		await typeAtEndOfFirstParagraph(editor, "b");

		const topLevel: ProseMirrorNode[] = [];
		editor.state.doc.forEach((node) => {
			if (converted.has(node)) topLevel.push(node);
		});
		expect(topLevel).toEqual([editor.state.doc.firstChild]);
	});

	it("hands back the blocks a keystroke didn't change as the same frozen objects", async () => {
		const { editor, values } = await renderHost(paragraphs(50));

		await typeAtEndOfFirstParagraph(editor, "ab");

		expect(values).toHaveLength(2);
		const [first, second] = values as [Blocks, Blocks];
		expect(second[0]).not.toBe(first[0]);
		const text = (block: Blocks[number]) =>
			(block as { children: Array<{ text: string }> }).children.map((span) => span.text).join("");
		expect(text(second[0])).toBe("Paragraph 0ab");
		for (let index = 1; index < first.length; index++) {
			expect(second[index]).toBe(first[index]);
		}
		expect(Object.isFrozen(second[1])).toBe(true);
		expect(Object.isFrozen((second[1] as { children: unknown[] }).children)).toBe(true);
	});

	it("dispatches nothing more than the keystrokes when the host passes the value back", async () => {
		const { editor, values } = await renderHost(paragraphs(20));
		await focusEditor(editor);
		let transactions = 0;
		const count = () => transactions++;
		editor.on("transaction", count);

		await typeAtEndOfFirstParagraph(editor, "abc");

		editor.off("transaction", count);
		expect(values).toHaveLength(3);
		expect(transactions).toBe(3);
	});
});
