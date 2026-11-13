import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { CodeBlockExtension } from "../../src/components/editor/CodeBlockNode.js";
import { render } from "../utils/render.js";

import "../../src/styles.css";

function CodeEditor({
	language,
	code,
	onEditor,
}: {
	language: string | null | undefined;
	code: string;
	onEditor?: (editor: Editor) => void;
}) {
	const editor = useEditor({
		extensions: [StarterKit.configure({ codeBlock: false }), CodeBlockExtension],
		content: {
			type: "doc",
			content: [
				{ type: "codeBlock", attrs: { language }, content: [{ type: "text", text: code }] },
			],
		},
		immediatelyRender: true,
	});

	useEffect(() => {
		if (editor) onEditor?.(editor);
	}, [editor, onEditor]);
	return <EditorContent editor={editor} />;
}

describe("CodeBlockExtension highlighting", () => {
	it.each([
		["javascript", 'const greeting = "hello";'],
		["dockerfile", "FROM node:22"],
	])("renders syntax tokens for %s", async (language, code) => {
		let editor: Editor | undefined;
		const screen = await render(
			<CodeEditor language={language} code={code} onEditor={(instance) => (editor = instance)} />,
		);

		await vi.waitFor(() => {
			expect(screen.container.querySelector("code")?.textContent).toBe(code);
			expect(screen.container.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});

		expect(JSON.stringify(editor!.getJSON())).not.toContain("hljs-");
	});

	it.each(["plaintext", "astro", "zig", "custom-language", null, undefined])(
		"leaves %s code unhighlighted",
		async (language) => {
			const screen = await render(
				<CodeEditor language={language} code={'const greeting = "hello";'} />,
			);

			await vi.waitFor(() => {
				expect(screen.container.querySelector("code")?.textContent).toBe(
					'const greeting = "hello";',
				);
			});
			expect(screen.container.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
		},
	);

	it("updates decorations when the selected language changes", async () => {
		let editor: Editor | undefined;
		const screen = await render(
			<CodeEditor
				language="javascript"
				code={'const greeting = "hello";'}
				onEditor={(instance) => (editor = instance)}
			/>,
		);
		const editorElement = screen.container.querySelector(".ProseMirror")!;

		await vi.waitFor(() => {
			expect(editorElement.querySelectorAll('span[class*="hljs-"]').length).toBeGreaterThan(0);
		});

		editor!.commands.setNodeSelection(0);
		editor!.commands.updateAttributes("codeBlock", { language: "astro" });
		await vi.waitFor(() => {
			expect(editorElement.querySelectorAll('span[class*="hljs-"]')).toHaveLength(0);
		});
		expect(editor!.getJSON().content?.[0]?.content?.[0]?.text).toBe('const greeting = "hello";');
	});
});

describe("CodeBlockExtension highlighting while editing around code", () => {
	function DocumentEditor({ onEditor }: { onEditor: (editor: Editor) => void }) {
		const editor = useEditor({
			extensions: [StarterKit.configure({ codeBlock: false }), CodeBlockExtension],
			content: {
				type: "doc",
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "Intro" }] },
					{
						type: "codeBlock",
						attrs: { language: "javascript" },
						content: [{ type: "text", text: "let a" }],
					},
				],
			},
			immediatelyRender: true,
		});
		useEffect(() => {
			if (editor) onEditor(editor);
		}, [editor, onEditor]);
		return <EditorContent editor={editor} />;
	}

	async function renderDocument() {
		let editor: Editor | undefined;
		const screen = await render(<DocumentEditor onEditor={(instance) => (editor = instance)} />);
		await vi.waitFor(() => expect(editor).toBeTruthy());
		const tokens = (selector: string) =>
			Array.from(screen.container.querySelectorAll(`pre ${selector}`), (span) => span.textContent);
		await vi.waitFor(() => expect(tokens(".hljs-keyword")).toEqual(["let"]));
		return { editor: editor!, tokens };
	}

	it("keeps the code highlighted while text before it changes", async () => {
		const { editor, tokens } = await renderDocument();

		editor.commands.insertContentAt(6, " and more");

		expect(editor.state.doc.firstChild?.textContent).toBe("Intro and more");
		expect(tokens(".hljs-keyword")).toEqual(["let"]);
	});

	it("highlights code as it is typed", async () => {
		const { editor, tokens } = await renderDocument();
		const codeEnd = editor.state.doc.content.size - 1;

		editor.chain().setTextSelection(codeEnd).insertContent(' = "hi"').run();

		await vi.waitFor(() => expect(tokens(".hljs-string")).toEqual(['"hi"']));
	});

	it("highlights a code block added to the document", async () => {
		const { editor, tokens } = await renderDocument();

		editor.commands.insertContentAt(0, {
			type: "codeBlock",
			attrs: { language: "javascript" },
			content: [{ type: "text", text: "const b" }],
		});

		await vi.waitFor(() => expect(tokens(".hljs-keyword")).toEqual(["const", "let"]));
	});
});
