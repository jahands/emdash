/**
 * Same-origin media rendered through Astro's image service: srcset candidates
 * must not claim more pixels than the source has, and body images must be
 * sized for their column rather than for the source width.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, test } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Image from "../../src/components/Image.astro";
import PortableText from "../../src/components/PortableText.astro";

const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};
const request = new Request("https://quality.example.com/");

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");
const descriptors = (srcset: string | undefined) =>
	(srcset ?? "").split(", ").map((candidate) => Number(candidate.match(/ (\d+)w$/)?.[1]));

function bodyImage(overrides: Record<string, unknown> = {}) {
	return {
		_type: "image" as const,
		_key: "body",
		asset: { _ref: "media-1", url: "/_emdash/api/media/file/harbor.jpg" },
		alt: "Harbor",
		width: 4000,
		height: 3000,
		...overrides,
	};
}

async function render(
	component: Parameters<AstroContainer["renderToString"]>[0],
	props: Record<string, unknown>,
) {
	const container = await AstroContainer.create();
	return container.renderToString(component, { props, locals, request });
}

describe("srcset candidates", () => {
	test("body image candidates stop at the source width", async () => {
		const tag = imgTags(await render(Image, { node: bodyImage() }))[0]!;

		expect(attr(tag, "data-astro-image")).toBe("constrained");
		const widths = descriptors(attr(tag, "srcset"));
		expect(widths.length).toBeGreaterThan(1);
		expect(Math.max(...widths)).toBe(4000);
	});

	test("field image candidates stop at the source width", async () => {
		const tag = imgTags(
			await render(EmDashImage, {
				image: {
					id: "01HERO",
					meta: { storageKey: "workshop.jpg" },
					alt: "Workshop",
					width: 2400,
					height: 1600,
				},
			}),
		)[0]!;

		const widths = descriptors(attr(tag, "srcset"));
		expect(Math.max(...widths)).toBe(2400);
		expect(attr(tag, "width")).toBe("2400");
		expect(attr(tag, "height")).toBe("1600");
	});
});

describe("body image sizes", () => {
	test("lets the browser use the laid-out width, falling back to the source width", async () => {
		const tag = imgTags(await render(Image, { node: bodyImage() }))[0]!;

		expect(attr(tag, "sizes")).toBe("auto, (min-width: 4000px) 4000px, 100vw");
		expect(attr(tag, "loading")).toBe("lazy");
	});

	test("uses the column sizes passed to PortableText", async () => {
		const tag = imgTags(
			await render(PortableText, {
				value: [bodyImage()],
				imageSizes: "(min-width: 760px) 680px, calc(100vw - 2rem)",
			}),
		)[0]!;

		expect(attr(tag, "sizes")).toBe("auto, (min-width: 760px) 680px, calc(100vw - 2rem)");
		expect(attr(tag, "width")).toBe("4000");
		expect(attr(tag, "height")).toBe("3000");
	});

	test("an image with its own display width keeps that width", async () => {
		const tag = imgTags(
			await render(PortableText, {
				value: [bodyImage({ displayWidth: 320 })],
				imageSizes: "(min-width: 760px) 680px, calc(100vw - 2rem)",
			}),
		)[0]!;

		expect(attr(tag, "sizes")).toBe("auto, (min-width: 320px) 320px, 100vw");
	});
});
