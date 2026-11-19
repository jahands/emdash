import assert from "node:assert/strict";
import test from "node:test";

import { assertHeaviestEntry, countBodyImages, longBody } from "../lib/seed.mjs";

const media = Array.from({ length: 12 }, (_, i) => ({
	id: `m${i}`,
	url: `/_emdash/api/media/file/m${i}.jpg`,
	filename: `m${i}.jpg`,
	width: 1600,
	height: 1200,
}));
const TOO_MANY = /cannot hold 13 distinct images/;
const DRIFTED = /has 4 body image blocks using 3 distinct files/;
const NO_FEATURED = /and no featured image/;
const fields = { mediaCount: 12, imageField: "featured_image", bodyField: "content" };

void test("the long entry holds every uploaded file once, between paragraphs", () => {
	const body = longBody(media, 0, 12);
	assert.deepEqual(countBodyImages(body), { blocks: 12, distinct: 12 });
	assert.equal(body[0]._type, "block", "the body opens with text");
	for (let i = 1; i < body.length; i++) {
		assert.ok(
			!(body[i]._type === "image" && body[i - 1]._type === "image"),
			"images are separated by paragraphs",
		);
	}
	assert.deepEqual(countBodyImages(longBody(media, 5, 2)), { blocks: 2, distinct: 2 });
	assert.throws(() => longBody(media, 0, 13), TOO_MANY);
});

void test("a stored entry that drifted from the seed plan fails the seed", () => {
	const featured = { id: "m0", src: "/m0.jpg" };
	assert.deepEqual(
		assertHeaviestEntry({ featured_image: featured, content: longBody(media, 0, 12) }, fields),
		{ bodyImages: 12, distinctBodyImages: 12, featured: true },
	);
	const reused = [3, 7, 11, 3].map((i) => ({ _type: "image", asset: { _ref: `m${i}` } }));
	assert.throws(
		() => assertHeaviestEntry({ featured_image: featured, content: reused }, fields),
		DRIFTED,
	);
	assert.throws(
		() => assertHeaviestEntry({ content: longBody(media, 0, 12) }, fields),
		NO_FEATURED,
	);
});
