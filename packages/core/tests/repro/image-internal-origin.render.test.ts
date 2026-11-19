/**
 * A build without a site URL gives same-origin media the internal origin, so
 * Astro's image service optimizes it without the site host being allowlisted.
 * `getImage` is stubbed as Cloudflare's URL service (`/cdn-cgi/image/...`),
 * which embeds the source in the path, and as an `/_image` endpoint service,
 * which embeds it in the query.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, test, vi } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";
import Image from "../../src/components/Image.astro";
import { INTERNAL_MEDIA_IMAGE_ORIGIN } from "../../src/media/responsive.js";

vi.mock("virtual:emdash/config", () => ({
	default: { internalMediaOrigin: "http://emdash-media.invalid" },
}));

const service = vi.hoisted(() => ({ mode: "cdn" as "cdn" | "endpoint" }));

vi.mock("astro:assets", async (importOriginal) => {
	const mod = await importOriginal<Record<string, unknown>>();
	const url = (src: string, w: number) =>
		service.mode === "cdn"
			? `/cdn-cgi/image/width=${w}/${src}`
			: `/_image?href=${encodeURIComponent(src)}&w=${w}`;
	return {
		...mod,
		getImage: vi.fn(async (opts: { src: string; width: number; widths?: number[] }) => {
			if (!opts.src.startsWith("http://emdash-media.invalid/")) return { src: opts.src };
			const widths = opts.widths ?? [opts.width];
			const values = widths.map((w) => `${url(opts.src, w)} ${w}w`);
			return {
				src: url(opts.src, opts.width),
				srcSet: { values, attribute: values.join(", ") },
				options: { widths },
				attributes: { width: opts.width, loading: "lazy" },
			};
		}),
	};
});

const locals = {
	emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` },
};
const request = new Request("https://preview.example.workers.dev/");

const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

const node = {
	_type: "image",
	_key: "body",
	asset: { _ref: "media-1", url: "/_emdash/api/media/file/harbor.jpg" },
	alt: "Harbor",
	width: 1200,
	height: 800,
};

async function render(
	component: Parameters<AstroContainer["renderToString"]>[0],
	props: Record<string, unknown>,
) {
	const container = await AstroContainer.create();
	return container.renderToString(component, { props, locals, request });
}

describe("same-origin media without a build-time site URL", () => {
	beforeEach(() => {
		service.mode = "cdn";
	});

	test("path-embedded transform URLs point at the site-relative source", async () => {
		const tag = imgTag(await render(Image, { node }));

		expect(attr(tag, "src")).toBe("/cdn-cgi/image/width=1200/_emdash/api/media/file/harbor.jpg");
		expect(attr(tag, "srcset")).toBe(
			"/cdn-cgi/image/width=1200/_emdash/api/media/file/harbor.jpg 1200w",
		);
		expect(tag).not.toContain("emdash-media.invalid");
	});

	test("endpoint URLs carry the internal source, which the endpoint reads from storage", async () => {
		service.mode = "endpoint";
		const tag = imgTag(
			await render(EmDashImage, {
				image: { id: "01", meta: { storageKey: "harbor.jpg" }, alt: "", width: 1200, height: 800 },
			}),
		);

		expect(attr(tag, "src")).toBe(
			`/_image?href=${encodeURIComponent(`${INTERNAL_MEDIA_IMAGE_ORIGIN}/_emdash/api/media/file/harbor.jpg`)}&w=1200`,
		);
	});
});
