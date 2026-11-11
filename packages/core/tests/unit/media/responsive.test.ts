import { describe, it, expect, vi } from "vitest";

import {
	INTERNAL_MEDIA_IMAGE_ORIGIN,
	PORTABLE_TEXT_IMAGE_SIZES,
	RESPONSIVE_BREAKPOINTS,
	buildResponsiveImage,
	capCandidateWidths,
	formatContentType,
	gallerySizes,
	lazyImageSizes,
	mediaImageOrigin,
	optimizeImage,
	portableTextImageSizes,
	responsiveSizes,
	responsiveWidths,
	stripInternalMediaOrigin,
	toAbsoluteMediaUrl,
	type GetImage,
} from "../../../src/media/responsive.js";

describe("responsiveWidths", () => {
	it("never generates a candidate wider than the endpoint's largest rendition", () => {
		expect(Math.max(...responsiveWidths(6000))).toBe(4000);
		expect(Math.max(...responsiveWidths(6000, 8000))).toBe(4000);
	});

	it("includes breakpoints up to 2x the rendered width", () => {
		expect(responsiveWidths(400)).toEqual([400, 640, 750, 800]);
	});

	it("offers 1x and 2x for images narrower than the first breakpoint", () => {
		expect(responsiveWidths(40)).toEqual([40, 80]);
	});

	it("adds 2x only up to the largest breakpoint", () => {
		expect(responsiveWidths(900)).toContain(1800);
		expect(responsiveWidths(1000)).not.toContain(2000);
	});

	it("offers the original instead of an upscaled high-density width", () => {
		expect(responsiveWidths(40, 40)).toEqual([40]);
		expect(responsiveWidths(40, 60)).toEqual([40, 60]);
		expect(responsiveWidths(400, 700)).toEqual([400, 640, 700]);
		expect(responsiveWidths(1000, 500)).toEqual([500]);
	});

	it("rounds fractional widths and ignores unusable original widths", () => {
		expect(responsiveWidths(40.4, 60.6)).toEqual([40, 61]);
		expect(responsiveWidths(40, -5)).toEqual([40, 80]);
	});

	it("returns no widths for unusable rendered widths", () => {
		expect(responsiveWidths(0.3)).toEqual([]);
		expect(responsiveWidths(0)).toEqual([]);
		expect(responsiveWidths(-5)).toEqual([]);
		expect(responsiveWidths(Number.NaN)).toEqual([]);
	});

	it("always includes the rendered width and sorts ascending", () => {
		const widths = responsiveWidths(800);
		expect(widths).toContain(800);
		expect(widths.toSorted((a, b) => a - b)).toEqual(widths);
	});

	it("does not duplicate a width already present in the breakpoints", () => {
		const widths = responsiveWidths(640);
		expect(widths.filter((w) => w === 640)).toHaveLength(1);
	});

	it("caps at the largest breakpoint for very large widths", () => {
		const widths = responsiveWidths(4000);
		expect(widths).toEqual([...RESPONSIVE_BREAKPOINTS, 4000]);
	});
});

describe("responsiveSizes", () => {
	it("returns a width-aware sizes attribute when width is known", () => {
		expect(responsiveSizes(800)).toBe("(min-width: 800px) 800px, 100vw");
	});

	it("falls back to 100vw when width is unknown", () => {
		expect(responsiveSizes(undefined)).toBe("100vw");
	});
});

describe("gallerySizes", () => {
	it("estimates one cell of the grid, with two columns on narrow viewports", () => {
		expect(gallerySizes(3)).toBe(
			"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 2rem) / 3)",
		);
		expect(gallerySizes(5)).toBe(
			"(max-width: 640px) calc((100vw - 1rem) / 2), calc((100vw - 4rem) / 5)",
		);
	});

	it("uses the full viewport for a single column above the breakpoint", () => {
		expect(gallerySizes(1)).toBe("(max-width: 640px) calc((100vw - 1rem) / 2), 100vw");
	});

	it("falls back to three columns for a missing or unusable count", () => {
		const three = gallerySizes(3);
		expect(gallerySizes(undefined)).toBe(three);
		expect(gallerySizes(0)).toBe(three);
		expect(gallerySizes(2.5)).toBe(three);
		expect(gallerySizes(Number.NaN)).toBe(three);
	});
});

describe("buildResponsiveImage", () => {
	const ABS = "https://cdn.example.com/a.jpg";

	it("returns null without both dimensions (avoids inferSize fetch)", async () => {
		const getImage = vi.fn();
		expect(await buildResponsiveImage(getImage, { src: ABS, width: 800 })).toBeNull();
		expect(await buildResponsiveImage(getImage, { src: ABS, height: 600 })).toBeNull();
		expect(await buildResponsiveImage(getImage, { src: "", width: 800, height: 600 })).toBeNull();
		expect(getImage).not.toHaveBeenCalled();
	});

	it("returns null for relative URLs without calling getImage", async () => {
		const getImage = vi.fn();
		// Relative same-origin proxy/public URLs are never optimized by Astro's
		// image services; skip them rather than emit a no-op srcset.
		expect(
			await buildResponsiveImage(getImage, {
				src: "/_emdash/api/media/file/01ABC.jpg",
				width: 800,
				height: 600,
			}),
		).toBeNull();
		expect(getImage).not.toHaveBeenCalled();
	});

	it("delegates to getImage and maps the result for absolute authorized URLs", async () => {
		const getImage: GetImage = vi.fn(async (opts) => ({
			src: `/_image?href=${encodeURIComponent(opts.src)}&w=1200`,
			srcSet: { attribute: "/_image?href=a&w=640 640w, /_image?href=a&w=1200 1200w" },
		}));
		const result = await buildResponsiveImage(getImage, {
			src: ABS,
			width: 800,
			height: 600,
		});
		expect(result).toEqual({
			src: `/_image?href=${encodeURIComponent(ABS)}&w=1200`,
			srcset: "/_image?href=a&w=640 640w, /_image?href=a&w=1200 1200w",
			sizes: "(min-width: 800px) 800px, 100vw",
		});
		expect(getImage).toHaveBeenCalledWith({
			src: ABS,
			width: 800,
			height: 600,
			widths: responsiveWidths(800),
			sizes: "(min-width: 800px) 800px, 100vw",
		});
	});

	it("does not request widths above a known original width", async () => {
		const getImage: GetImage = vi.fn(async (opts) => ({ src: `/_image?href=${opts.src}` }));
		await buildResponsiveImage(getImage, { src: ABS, width: 400, height: 300, originalWidth: 400 });
		expect(getImage).toHaveBeenCalledWith(expect.objectContaining({ widths: [400] }));
	});

	it("passes a requested output format through to getImage", async () => {
		const getImage: GetImage = vi.fn(async (opts) => ({
			src: `/_image?href=${encodeURIComponent(opts.src)}&w=1200&f=${opts.format}`,
			srcSet: { attribute: "/_image?href=a&w=640&f=avif 640w" },
		}));
		await buildResponsiveImage(getImage, {
			src: ABS,
			width: 800,
			height: 600,
			format: "avif",
		});
		expect(getImage).toHaveBeenCalledWith(expect.objectContaining({ format: "avif" }));
	});

	it("returns null when the service passes the URL through unchanged (unauthorized host)", async () => {
		// baseService.getURL returns options.src verbatim for unauthorized hosts.
		const getImage: GetImage = async (opts) => ({ src: opts.src });
		expect(await buildResponsiveImage(getImage, { src: ABS, width: 800, height: 600 })).toBeNull();
	});

	it("returns null when getImage throws (no service available)", async () => {
		const getImage: GetImage = async () => {
			throw new Error("no image service");
		};
		expect(await buildResponsiveImage(getImage, { src: ABS, width: 800, height: 600 })).toBeNull();
	});
});

describe("formatContentType", () => {
	it("maps transform formats to their MIME types", () => {
		expect(formatContentType("avif")).toBe("image/avif");
		expect(formatContentType("webp")).toBe("image/webp");
		expect(formatContentType("jpeg")).toBe("image/jpeg");
		expect(formatContentType("jpg")).toBe("image/jpeg");
		expect(formatContentType("png")).toBe("image/png");
	});
});

describe("toAbsoluteMediaUrl", () => {
	const ORIGIN = "https://example.com";

	it("resolves a relative media path against the origin", () => {
		expect(toAbsoluteMediaUrl("/_emdash/api/media/file/01ABC.jpg", ORIGIN)).toBe(
			"https://example.com/_emdash/api/media/file/01ABC.jpg",
		);
	});

	it("returns already-absolute URLs unchanged", () => {
		expect(toAbsoluteMediaUrl("https://cdn.example.com/a.jpg", ORIGIN)).toBe(
			"https://cdn.example.com/a.jpg",
		);
	});

	it("returns the source unchanged when origin is missing", () => {
		expect(toAbsoluteMediaUrl("/path.jpg", undefined)).toBe("/path.jpg");
	});

	it("returns the source unchanged for an empty string", () => {
		expect(toAbsoluteMediaUrl("", ORIGIN)).toBe("");
	});

	it("returns non-path values unchanged (data:, blob:)", () => {
		expect(toAbsoluteMediaUrl("data:image/png;base64,abc", ORIGIN)).toBe(
			"data:image/png;base64,abc",
		);
		expect(toAbsoluteMediaUrl("blob:https://example.com/uuid", ORIGIN)).toBe(
			"blob:https://example.com/uuid",
		);
	});

	it("does not absolutize protocol-relative URLs (SSRF guard)", () => {
		expect(toAbsoluteMediaUrl("//evil.com/_emdash/api/media/file/x.jpg", ORIGIN)).toBe(
			"//evil.com/_emdash/api/media/file/x.jpg",
		);
	});

	it("does not let backslash tricks escape the origin (SSRF guard)", () => {
		// WHATWG URL normalizes backslashes to slashes for http(s), so
		// "/\\evil.com" would otherwise resolve to https://evil.com.
		expect(toAbsoluteMediaUrl("/\\evil.com/x.jpg", ORIGIN)).toBe("/\\evil.com/x.jpg");
		expect(toAbsoluteMediaUrl("/\\/evil.com/x.jpg", ORIGIN)).toBe("/\\/evil.com/x.jpg");
	});
});

describe("capCandidateWidths", () => {
	it("replaces candidates wider than the source with the source width", () => {
		expect(capCandidateWidths([640, 1280, 2400, 2560, 4800], 2400)).toEqual([640, 1280, 2400]);
		expect(capCandidateWidths([640, 1280, 3200, 4800], 2400)).toEqual([640, 1280, 2400]);
	});

	it("keeps candidates when none exceed the source", () => {
		expect(capCandidateWidths([640, 1280], 4000)).toEqual([640, 1280]);
	});

	it("keeps candidates when the source width is unknown", () => {
		expect(capCandidateWidths([640, 8000])).toEqual([640, 8000]);
		expect(capCandidateWidths([640, 8000], 0)).toEqual([640, 8000]);
	});
});

describe("lazyImageSizes", () => {
	it("lets supporting browsers use the laid-out width", () => {
		expect(lazyImageSizes("(min-width: 680px) 680px, 100vw")).toBe(
			"auto, (min-width: 680px) 680px, 100vw",
		);
	});

	it("does not repeat auto", () => {
		expect(lazyImageSizes("auto, 100vw")).toBe("auto, 100vw");
	});
});

describe("portableTextImageSizes", () => {
	it("reads the hint PortableText attached to a node", () => {
		const node = { _type: "image" };
		expect(portableTextImageSizes(node)).toBeUndefined();
		Reflect.set(node, PORTABLE_TEXT_IMAGE_SIZES, "680px");
		expect(portableTextImageSizes(node)).toBe("680px");
	});
});

describe("stripInternalMediaOrigin", () => {
	it("turns a path-embedded internal source into a site-relative path", () => {
		expect(
			stripInternalMediaOrigin(
				`/cdn-cgi/image/width=640/${INTERNAL_MEDIA_IMAGE_ORIGIN}/_emdash/api/media/file/a.jpg 640w, /cdn-cgi/image/width=1280/${INTERNAL_MEDIA_IMAGE_ORIGIN}/_emdash/api/media/file/a.jpg 1280w`,
			),
		).toBe(
			"/cdn-cgi/image/width=640/_emdash/api/media/file/a.jpg 640w, /cdn-cgi/image/width=1280/_emdash/api/media/file/a.jpg 1280w",
		);
	});

	it("leaves query-encoded sources alone", () => {
		const url = `/_image?href=${encodeURIComponent(`${INTERNAL_MEDIA_IMAGE_ORIGIN}/_emdash/api/media/file/a.jpg`)}&w=640`;
		expect(stripInternalMediaOrigin(url)).toBe(url);
	});
});

describe("mediaImageOrigin", () => {
	const publicOrigin = () => "https://site.example.com";

	it("uses the internal origin for on-demand pages", () => {
		expect(
			mediaImageOrigin({
				internalOrigin: INTERNAL_MEDIA_IMAGE_ORIGIN,
				isPrerendered: false,
				publicOrigin,
			}),
		).toBe(INTERNAL_MEDIA_IMAGE_ORIGIN);
	});

	it("uses the public origin for prerendered pages and when no internal origin is set", () => {
		expect(
			mediaImageOrigin({
				internalOrigin: INTERNAL_MEDIA_IMAGE_ORIGIN,
				isPrerendered: true,
				publicOrigin,
			}),
		).toBe("https://site.example.com");
		expect(
			mediaImageOrigin({ internalOrigin: undefined, isPrerendered: false, publicOrigin }),
		).toBe("https://site.example.com");
	});
});

describe("optimizeImage", () => {
	/** Mimics Astro's constrained layout: 1x and 2x the display width, no source cap. */
	function fakeGetImage(transformUrl: (src: string, width: number) => string) {
		return vi.fn<GetImage>(async (opts) => {
			const width = opts.width ?? 0;
			const widths = opts.widths ?? [width, width * 2];
			const values = widths.map((w) => ({ url: transformUrl(opts.src, w), descriptor: `${w}w` }));
			const { src: _src, widths: _widths, width: _w, height: _h, ...attributes } = opts;
			return {
				src: transformUrl(opts.src, width),
				srcSet: {
					values,
					attribute: values.map((v) => `${v.url} ${v.descriptor}`).join(", "),
				},
				options: { widths },
				attributes: { ...attributes, width, height: opts.height },
			};
		});
	}
	const endpoint = (src: string, w: number) =>
		`/_image?href=${encodeURIComponent(src)}&w=${w}&f=webp`;

	it("caps candidates at the source width", async () => {
		const getImage = fakeGetImage(endpoint);
		const result = await optimizeImage(
			getImage,
			{},
			{
				src: "https://site.example.com/_emdash/api/media/file/a.jpg",
				width: 2400,
				height: 1600,
				originalWidth: 2400,
			},
		);
		expect(result?.srcset).toContain("2400w");
		expect(result?.srcset).not.toContain("4800w");
		expect(getImage).toHaveBeenLastCalledWith(expect.objectContaining({ widths: [2400] }));
	});

	it("applies Astro's constrained-layout defaults", async () => {
		const getImage = fakeGetImage(endpoint);
		await optimizeImage(
			getImage,
			{ objectFit: "contain" },
			{ src: "https://site.example.com/a.jpg", width: 100, height: 100 },
		);
		expect(getImage).toHaveBeenCalledWith(
			expect.objectContaining({ layout: "constrained", fit: "contain", position: "center" }),
		);
	});

	it("returns the attributes for the img element", async () => {
		const result = await optimizeImage(
			fakeGetImage(endpoint),
			{},
			{
				src: "https://site.example.com/a.jpg",
				width: 100,
				height: 50,
				alt: "A",
				sizes: "100px",
			},
		);
		expect(result?.attributes).toMatchObject({ alt: "A", sizes: "100px", width: 100, height: 50 });
	});

	it("points path-embedded internal sources at the site", async () => {
		const cdn = (src: string, w: number) => `/cdn-cgi/image/width=${w}/${src}`;
		const result = await optimizeImage(
			fakeGetImage(cdn),
			{},
			{
				src: `${INTERNAL_MEDIA_IMAGE_ORIGIN}/_emdash/api/media/file/a.jpg`,
				width: 800,
				height: 600,
				originalWidth: 800,
			},
		);
		expect(result?.src).toBe("/cdn-cgi/image/width=800/_emdash/api/media/file/a.jpg");
		expect(result?.srcset).toBe("/cdn-cgi/image/width=800/_emdash/api/media/file/a.jpg 800w");
	});

	it("returns null for relative URLs, passthrough results and failures", async () => {
		const getImage = fakeGetImage(endpoint);
		expect(await optimizeImage(getImage, {}, { src: "/a.jpg", width: 1, height: 1 })).toBeNull();
		expect(getImage).not.toHaveBeenCalled();

		const passthrough = vi.fn<GetImage>(async (opts) => ({ src: opts.src }));
		expect(
			await optimizeImage(passthrough, {}, { src: "https://x.example/a.jpg", width: 1, height: 1 }),
		).toBeNull();

		const failing = vi.fn<GetImage>(async () => {
			throw new Error("no service");
		});
		expect(
			await optimizeImage(failing, {}, { src: "https://x.example/a.jpg", width: 1, height: 1 }),
		).toBeNull();
	});
});
