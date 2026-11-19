/**
 * Without a build-time site URL, every image service must still get a source
 * it can use: EmDash's endpoint reads the internal origin from storage by
 * path, and anything else needs the public origin or a site-relative path.
 * Each case resolves the image endpoint, internal origin and remote patterns
 * the way the integration does, then renders through Astro's real `getImage`.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { baseService } from "astro/assets";
import sharpService from "astro/assets/services/sharp";
import { isRemoteAllowed } from "astro/assets/utils";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
	buildImageRemotePatterns,
	resolveImageEndpoint,
	resolveInternalMediaOrigin,
} from "../../src/astro/integration/index.js";
import EmDashImage from "../../src/components/EmDashImage.astro";
import Gallery from "../../src/components/Gallery.astro";
import Image from "../../src/components/Image.astro";
import { matchInternalMediaKey } from "../../src/media/image-endpoint.js";
import { INTERNAL_MEDIA_IMAGE_ORIGIN } from "../../src/media/responsive.js";

const state = vi.hoisted(() => ({
	config: {} as { internalMediaOrigin?: string },
	getImage: undefined as undefined | ((options: unknown) => Promise<unknown>),
}));

vi.mock("virtual:emdash/config", () => ({ default: state.config }));
vi.mock("astro:assets", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getImage: (options: unknown) => state.getImage!(options),
}));

type Service = Record<string, unknown>;
type AstroGetImage = (options: unknown, imageConfig: unknown) => Promise<unknown>;

const require = createRequire(import.meta.url);
const astroRoot = dirname(require.resolve("astro/package.json"));
const { getImage: astroGetImage } = (await import(
	pathToFileURL(join(astroRoot, "dist/assets/internal.js")).href
)) as { getImage: AstroGetImage };

const STORAGE = {
	entrypoint: "emdash/storage/local",
	config: { directory: "./uploads", baseUrl: "/_emdash/api/media/file" },
};
const ORIGINAL = "/_emdash/api/media/file/harbor.jpg";
const PUBLIC_SOURCE = `https://site.example${ORIGINAL}`;

/** An external service whose CDN fetches the source itself, embedded in a query. */
const cdnService: Service = {
	...baseService,
	getURL: (options: { src: string; width?: number }) =>
		`https://images.example/resize?url=${encodeURIComponent(options.src)}&width=${options.width}`,
};

/** `@astrojs/cloudflare/image-service-workerd`: Astro's base service with a passthrough transform. */
const workerdService: Service = {
	...baseService,
	transform: async (data: Uint8Array, transform: { format: string }) => ({
		data,
		format: transform.format,
	}),
};

/** `@astrojs/cloudflare/image-service`: the source goes in a `/cdn-cgi/image/` path. */
const cloudflareUrlService: Service = {
	...baseService,
	getURL: (
		options: { src: string; width?: number },
		imageConfig: Parameters<typeof isRemoteAllowed>[1],
	) =>
		isRemoteAllowed(options.src, imageConfig)
			? `/cdn-cgi/image/onerror=redirect,width=${options.width}/${options.src}`
			: options.src,
};

interface Case {
	name: string;
	isCloudflare: boolean;
	serviceEntrypoint: string;
	service: Service;
	/** The source each transform URL hands to whatever fetches it. */
	sourceOf: (url: URL) => string | null;
	/** The source expected for the media file. */
	expected: string;
}

const viaEndpoint = (url: URL) =>
	url.pathname === "/_image" ? url.searchParams.get("href") : null;

const cases: Case[] = [
	{
		name: "a custom external image service on Node",
		isCloudflare: false,
		serviceEntrypoint: "./src/cdn-image-service.ts",
		service: cdnService,
		sourceOf: (url) => (url.host === "images.example" ? url.searchParams.get("url") : null),
		expected: PUBLIC_SOURCE,
	},
	{
		name: "a custom external image service on Cloudflare",
		isCloudflare: true,
		serviceEntrypoint: "./src/cdn-image-service.ts",
		service: cdnService,
		sourceOf: (url) => (url.host === "images.example" ? url.searchParams.get("url") : null),
		expected: PUBLIC_SOURCE,
	},
	{
		name: "Cloudflare URL transformations",
		isCloudflare: true,
		serviceEntrypoint: "@astrojs/cloudflare/image-service",
		service: cloudflareUrlService,
		sourceOf: (url) => {
			const match = /^\/cdn-cgi\/image\/[^/]+(\/.*)$/.exec(url.pathname);
			return match ? match[1]! : null;
		},
		expected: ORIGINAL,
	},
	{
		name: "Node sharp",
		isCloudflare: false,
		serviceEntrypoint: "astro/assets/services/sharp",
		service: sharpService as unknown as Service,
		sourceOf: viaEndpoint,
		expected: `${INTERNAL_MEDIA_IMAGE_ORIGIN}${ORIGINAL}`,
	},
	{
		name: "the Cloudflare Images binding endpoint",
		isCloudflare: true,
		serviceEntrypoint: "@astrojs/cloudflare/image-service-workerd",
		service: workerdService,
		sourceOf: viaEndpoint,
		expected: `${INTERNAL_MEDIA_IMAGE_ORIGIN}${ORIGINAL}`,
	},
];

const node = {
	_type: "image",
	_key: "harbor",
	asset: { _ref: "media-1", url: ORIGINAL },
	alt: "Harbor",
	width: 1200,
	height: 800,
};
const components = [
	{
		name: "EmDashImage",
		component: EmDashImage,
		props: { image: { id: "media-1", src: ORIGINAL, alt: "Harbor", width: 1200, height: 800 } },
	},
	{ name: "Portable Text Image", component: Image, props: { node } },
	{
		name: "Gallery",
		component: Gallery,
		props: { node: { _type: "gallery", _key: "gallery", images: [node] } },
	},
];

const locals = {
	emdash: { getPublicMediaUrl: (key: string) => `/_emdash/api/media/file/${key}` },
};

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

function renderedUrls(tag: string): string[] {
	const srcset = attr(tag, "srcset") ?? "";
	return [
		attr(tag, "src") ?? "",
		...srcset
			.split(", ")
			.map((candidate) => candidate.split(" ")[0]!)
			.filter(Boolean),
	];
}

const originalAstroAsset = globalThis.astroAsset;
beforeAll(() => {
	globalThis.astroAsset = { ...originalAstroAsset };
});
afterAll(() => {
	globalThis.astroAsset = originalAstroAsset;
});

describe.each(cases)("media sources with $name and no build-time site URL", (scenario) => {
	beforeAll(() => {
		const { entrypoint } = resolveImageEndpoint({
			imagesDisabled: false,
			currentEntrypoint: undefined,
			isCloudflare: scenario.isCloudflare,
			imageServiceEntrypoint: scenario.serviceEntrypoint,
		});
		const internalMediaOrigin = resolveInternalMediaOrigin({
			siteUrl: undefined,
			command: "build",
			ownImageEndpoint: Boolean(entrypoint),
			imageServiceEntrypoint: scenario.serviceEntrypoint,
		});
		state.config.internalMediaOrigin = internalMediaOrigin;
		const imageConfig = {
			endpoint: { route: "/_image" },
			service: { entrypoint: scenario.serviceEntrypoint, config: {} },
			domains: [],
			remotePatterns: buildImageRemotePatterns(STORAGE, undefined, "build", internalMediaOrigin),
		};
		globalThis.astroAsset.imageService = scenario.service as never;
		state.getImage = (options) => astroGetImage(options, imageConfig);
	});

	test.each(components)("$name hands every transform a source it can use", async (entry) => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(entry.component, {
			props: entry.props,
			locals,
			request: new Request("https://site.example/article"),
		});
		const tags = imgTags(html);
		expect(tags.length).toBeGreaterThan(0);

		for (const tag of tags) {
			for (const rendered of renderedUrls(tag)) {
				const source = scenario.sourceOf(new URL(rendered, "https://site.example"));
				expect(source, `${rendered} is not a transform URL`).not.toBeNull();
				expect(source).toBe(scenario.expected);
				if (source!.startsWith(INTERNAL_MEDIA_IMAGE_ORIGIN)) {
					expect(matchInternalMediaKey(source)).toBe("harbor.jpg");
				}
			}
		}
	});
});
