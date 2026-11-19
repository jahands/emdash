// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";

import {
	EmDashOrderedList,
	normalizeOrderedListDocument,
} from "../../src/components/editor/ordered-list";

const editors: Editor[] = [];

function list(attrs: Record<string, unknown>, labels: string[]): JSONContent {
	return {
		type: "orderedList",
		attrs,
		content: labels.map((label) => ({
			type: "listItem",
			content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
		})),
	};
}

function createEditor(content: JSONContent): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit.configure({ orderedList: false }), EmDashOrderedList],
		content,
	});
	editors.push(editor);
	return editor;
}

function orderedNodes(editor: Editor) {
	const nodes: Array<{ attrs: Record<string, unknown>; pos: number }> = [];
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "orderedList") nodes.push({ attrs: node.attrs, pos });
	});
	return nodes;
}

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

describe("admin EmDashOrderedList", () => {
	it("derives continuation starts with the core extension contract", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 1, listStart: 1, listId: "shared" }, ["Three"]),
			],
		});

		expect(normalizeOrderedListDocument(editor.state.doc)[0]?.attrs.start).toBe(3);
	});

	it("continues and restarts a selected list tail", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "first" }, ["One"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 1, listStart: 1, listId: "second" }, ["Independent"]),
			],
		});
		let lists = orderedNodes(editor);
		editor.commands.setTextSelection(lists[1]!.pos + 2);
		expect(editor.commands.continueOrderedList()).toBe(true);
		lists = orderedNodes(editor);
		expect(lists.map((node) => node.attrs.start)).toEqual([1, 2]);

		editor.commands.setTextSelection(lists[1]!.pos + 2);
		expect(editor.commands.restartOrderedList()).toBe(true);
		lists = orderedNodes(editor);
		expect(lists[1]!.attrs.listId).not.toBe("first");
		expect(lists[1]!.attrs.start).toBe(1);
	});

	it("keeps counting lists after text before them changes", () => {
		const nested = (start: number, labels: string[]) =>
			list({ start, listStart: 1, listId: "nested" }, labels);
		const editor = createEditor({
			type: "doc",
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Intro" }] },
				list({ start: 1, listStart: 1, listId: "shared" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 3, listStart: 1, listId: "shared" }, ["Three"]),
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Item" }] },
								nested(1, ["a", "b"]),
								{ type: "paragraph", content: [{ type: "text", text: "Aside" }] },
								nested(3, ["c"]),
							],
						},
					],
				},
			],
		});
		const starts = () => orderedNodes(editor).map((node) => node.attrs.start);
		const item = (text: string) => list({}, [text]).content![0]!;

		editor.commands.insertContentAt(6, " grows");
		expect(starts()).toEqual([1, 3, 1, 3]);

		editor.commands.insertContentAt(orderedNodes(editor)[0]!.pos + 1, item("Zero"));
		editor.commands.insertContentAt(orderedNodes(editor)[2]!.pos + 1, item("z"));
		expect(starts()).toEqual([1, 4, 1, 4]);
	});
});
