import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, it, expect } from "vitest";

import { documentMetrics } from "../../src/components/PortableTextEditor";

const schema = getSchema([StarterKit]);

const words = (n: number) => "word ".repeat(n).trim();

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function doc(...blocks: JSONContent[]): ProseMirrorNode {
	return schema.nodeFromJSON({ type: "doc", content: blocks });
}

const paragraphs = (...texts: string[]) =>
	doc(...texts.map((value) => (value ? paragraph(text(value)) : { type: "paragraph" })));

const readingTime = (value: string) => documentMetrics(paragraphs(value)).readingTime;
const wordCount = (value: string) => documentMetrics(paragraphs(value)).words;

describe("Editor Metrics", () => {
	describe("reading time", () => {
		it("returns 0 minutes for empty document", () => {
			expect(readingTime("")).toBe(0);
		});

		it("returns 1 minute for less than 200 words", () => {
			expect(readingTime(words(1))).toBe(1);
			expect(readingTime(words(100))).toBe(1);
			expect(readingTime(words(199))).toBe(1);
		});

		it("returns 1 minute for exactly 200 words", () => {
			expect(readingTime(words(200))).toBe(1);
		});

		it("returns 2 minutes for 201-400 words", () => {
			expect(readingTime(words(201))).toBe(2);
			expect(readingTime(words(300))).toBe(2);
			expect(readingTime(words(400))).toBe(2);
		});

		it("returns correct reading time for larger documents", () => {
			expect(readingTime(words(1000))).toBe(5);
			expect(readingTime(words(1001))).toBe(6);
			expect(readingTime(words(2000))).toBe(10);
		});

		it("always rounds up (ceil)", () => {
			// 201 / 200 = 1.005, ceil = 2
			expect(readingTime(words(201))).toBe(2);
			// 401 / 200 = 2.005, ceil = 3
			expect(readingTime(words(401))).toBe(3);
		});

		it("counts CJK content by character, matching the published reading time", () => {
			// Without the CJK rate, a spaceless paragraph counts as one word and
			// collapses to "1 min read". 2000 / 500 = 4 minutes, the same result
			// as the published reading-time util's CJK test.
			expect(readingTime("日".repeat(2000))).toBe(4);
			expect(readingTime("中".repeat(1000))).toBe(2);
			expect(readingTime("한".repeat(2000))).toBe(4);
		});

		it("adds word-based and CJK reading time for mixed content", () => {
			// 200 words (1 min) + 500 CJK characters (1 min) = 2 minutes
			expect(readingTime(`${words(200)} ${"日".repeat(500)}`)).toBe(2);
		});

		it("sums reading time across blocks before rounding", () => {
			// 150 + 150 words = 1.5 minutes, not two blocks of 1 minute each
			expect(documentMetrics(paragraphs(words(150), words(150))).readingTime).toBe(2);
			expect(documentMetrics(paragraphs(words(100), words(100))).readingTime).toBe(1);
			// 250 CJK characters in each of two blocks = 1 minute
			const cjk = "日".repeat(250);
			expect(documentMetrics(paragraphs(cjk, cjk)).readingTime).toBe(1);
		});
	});

	describe("word count", () => {
		it("counts space-separated words for word-based scripts", () => {
			expect(wordCount("")).toBe(0);
			expect(wordCount("hello world")).toBe(2);
		});

		it("counts CJK characters individually", () => {
			expect(wordCount("日本語")).toBe(3);
			expect(wordCount("中文测试")).toBe(4);
			expect(wordCount("ひらがなカタカナ한국어")).toBe(11);
		});

		it("combines word-based and CJK counts", () => {
			expect(wordCount("hello 日本")).toBe(3);
			expect(wordCount("Tiptap是一个编辑器")).toBe(7);
		});
	});

	describe("documents", () => {
		it("never joins words across blocks", () => {
			expect(documentMetrics(paragraphs("hello", "world"))).toEqual({
				words: 2,
				characters: 10,
				readingTime: 1,
			});
		});

		it("counts text in headings, lists, quotes and code", () => {
			const metrics = documentMetrics(
				doc(
					{ type: "heading", attrs: { level: 2 }, content: [text("Title")] },
					{
						type: "bulletList",
						content: [
							{ type: "listItem", content: [paragraph(text("one"))] },
							{ type: "listItem", content: [paragraph(text("two"))] },
						],
					},
					{ type: "blockquote", content: [paragraph(text("中文"))] },
					{ type: "codeBlock", content: [text("let x")] },
				),
			);
			expect(metrics).toEqual({ words: 7, characters: 18, readingTime: 1 });
		});

		it("separates the words on either side of a line break", () => {
			const metrics = documentMetrics(
				doc(paragraph(text("first"), { type: "hardBreak" }, text("second"))),
			);
			expect(metrics.words).toBe(2);
			expect(metrics.characters).toBe(12);
		});

		it("counts nothing in an empty document", () => {
			expect(documentMetrics(paragraphs(""))).toEqual({
				words: 0,
				characters: 0,
				readingTime: 0,
			});
		});
	});

	describe("after edits", () => {
		function edit(start: ProseMirrorNode, change: (state: EditorState) => EditorState) {
			const before = EditorState.create({ schema, doc: start });
			documentMetrics(before.doc);
			return documentMetrics(change(before).doc);
		}

		it("counts text typed into one block of many", () => {
			const start = paragraphs(...Array.from<string>({ length: 50 }).fill("alpha beta"));
			const position = start.child(0).nodeSize + 1;
			const metrics = edit(start, (state) =>
				state.apply(state.tr.insertText("gamma 日本 ", position)),
			);
			expect(metrics.words).toBe(50 * 2 + 3);
			expect(metrics.characters).toBe(50 * 10 + 9);
		});

		it("counts a block split in two and a block deleted", () => {
			const start = paragraphs("alphabeta", "gamma");
			const split = edit(start, (state) => state.apply(state.tr.split(1 + "alpha".length)));
			expect(split.words).toBe(3);
			expect(split.characters).toBe(14);

			const deleted = edit(start, (state) =>
				state.apply(state.tr.delete(0, start.child(0).nodeSize)),
			);
			expect(deleted).toEqual({ words: 1, characters: 5, readingTime: 1 });
		});

		it("counts CJK text replaced inside a block", () => {
			const start = paragraphs("日本語", "hello");
			const metrics = edit(start, (state) => state.apply(state.tr.insertText("中文", 1, 4)));
			expect(metrics.words).toBe(3);
			expect(metrics.characters).toBe(7);
		});
	});
});
