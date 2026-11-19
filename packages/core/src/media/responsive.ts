/**
 * Responsive image helpers shared by the public Image components.
 *
 * These build a `srcset` for locally-stored / R2-stored media by delegating to
 * Astro's configured image service (`astro:assets`). On Cloudflare that is the
 * Images binding; on Node it is sharp; if neither is available it is a no-op
 * passthrough. The calling `.astro` component passes Astro's `getImage` in so
 * this module stays free of the `astro:assets` virtual import (which only
 * resolves inside an Astro project, not in this precompiled package).
 */

import { MAX_TRANSFORM_DIMENSION } from "./image-endpoint.js";
import type { EmbedOptions } from "./types.js";

/** Standard responsive breakpoints. Matches CDN-provider srcset generation. */
export const RESPONSIVE_BREAKPOINTS = [640, 750, 828, 960, 1080, 1280, 1600, 1920];

/** Matches absolute http(s) URLs — the only shape Astro's image services optimize. */
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

/**
 * Pick the srcset widths to generate for an image rendered at `maxWidth`.
 * Includes breakpoints up to 2x (retina) plus the rendered width itself, so the
 * browser always has an exact-fit candidate. A known `originalWidth` below 2x
 * lowers that limit, so the source is never upscaled for a high-density
 * candidate. The limit itself is a candidate up to the largest breakpoint, so
 * images narrower than the first breakpoint still get one. No candidate exceeds
 * {@link MAX_TRANSFORM_DIMENSION}, the largest rendition the endpoint makes.
 */
export function responsiveWidths(maxWidth: number, originalWidth?: number): number[] {
	const width = Math.min(Math.round(maxWidth), MAX_TRANSFORM_DIMENSION);
	if (!(width >= 1)) return [];
	const original = Math.round(originalWidth ?? 0);
	const cap = Math.min(
		original >= 1 && original < width * 2 ? original : width * 2,
		MAX_TRANSFORM_DIMENSION,
	);
	const widths = new Set(RESPONSIVE_BREAKPOINTS.filter((w) => w <= cap));
	widths.add(Math.min(width, cap));
	if (cap <= Math.max(...RESPONSIVE_BREAKPOINTS)) widths.add(cap);
	return [...widths].toSorted((a, b) => a - b);
}

/**
 * Bound srcset candidate widths by the source's intrinsic width. Wider
 * candidates would either be upscaled or delivered at the source width while
 * their `w` descriptor claims more pixels, so they are replaced by a single
 * candidate at the source width.
 */
export function capCandidateWidths(widths: readonly number[], originalWidth?: number): number[] {
	const original = Math.round(originalWidth ?? 0);
	if (!(original >= 1)) return [...widths];
	const kept = widths.filter((w) => w <= original);
	if (kept.length < widths.length) kept.push(original);
	return [...new Set(kept)].toSorted((a, b) => a - b);
}

/** Build the `sizes` attribute for an image with a known display width. */
export function responsiveSizes(width: number | undefined): string {
	return width ? `(min-width: ${width}px) ${width}px, 100vw` : "100vw";
}

/**
 * `sizes` for a lazy image whose box never crops it. Browsers that support
 * `sizes="auto"` use the laid-out width; others use `fallback`.
 */
export function lazyImageSizes(fallback: string): string {
	return fallback.trimStart().startsWith("auto") ? fallback : `auto, ${fallback}`;
}

/**
 * Property under which `PortableText` hands its `imageSizes` prop to the image
 * blocks it renders. Portable Text components receive only the node, so the
 * hint travels on the node object.
 */
export const PORTABLE_TEXT_IMAGE_SIZES = Symbol.for("emdash.portableText.imageSizes");

/** The `imageSizes` hint `PortableText` attached to an image node, if any. */
export function portableTextImageSizes(node: object): string | undefined {
	const value: unknown = Reflect.get(node, PORTABLE_TEXT_IMAGE_SIZES);
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Origin given to same-origin media when the site URL is unknown at build.
 *
 * Astro only optimizes absolute URLs on an allowlisted host. Authorizing the
 * real site host needs it at build time; authorizing every host would let the
 * image endpoint fetch arbitrary URLs. `.invalid` never resolves (RFC 6761),
 * so allowlisting it opens no fetchable host: EmDash's image endpoint reads
 * the media from storage by its path, and any other fetch of it fails.
 */
export const INTERNAL_MEDIA_IMAGE_ORIGIN = "http://emdash-media.invalid";

const INTERNAL_MEDIA_IN_PATH = `/${INTERNAL_MEDIA_IMAGE_ORIGIN}/`;

/**
 * Make a transform URL that embeds {@link INTERNAL_MEDIA_IMAGE_ORIGIN} as a
 * path segment (Cloudflare `/cdn-cgi/image/<options>/<source>`) point at the
 * site-relative source instead. Query-string embeddings (`/_image?href=`) are
 * percent-encoded and left alone; the endpoint matches those by path.
 */
export function stripInternalMediaOrigin(url: string): string {
	return url.replaceAll(INTERNAL_MEDIA_IN_PATH, "/");
}

/**
 * The origin to absolutize same-origin media against before handing it to
 * Astro's image service. Prerendered pages keep the public origin: Astro
 * fetches their images at build time, and the internal origin is not fetchable.
 */
export function mediaImageOrigin(opts: {
	internalOrigin: string | undefined;
	isPrerendered: boolean;
	publicOrigin: () => string;
}): string {
	if (opts.internalOrigin && !opts.isPrerendered) return opts.internalOrigin;
	return opts.publicOrigin();
}

/** Column count `Gallery.astro` uses when a gallery block does not set one. */
export const GALLERY_DEFAULT_COLUMNS = 3;

/**
 * Build the `sizes` attribute for one cell of a Portable Text gallery.
 *
 * Mirrors the gallery's CSS: `columns` equal cells with a `1rem` gap, and two
 * columns at `640px` and below. Each cell is estimated against the viewport, so
 * a gallery inside a narrower content column still gets a larger slot than it
 * renders at; pass `sizes` to `Gallery` when the container width is known.
 */
export function gallerySizes(columns: number | undefined): string {
	const count =
		typeof columns === "number" && Number.isInteger(columns) && columns > 0
			? columns
			: GALLERY_DEFAULT_COLUMNS;
	return `(max-width: 640px) ${galleryCell(2)}, ${galleryCell(count)}`;
}

function galleryCell(columns: number): string {
	return columns === 1 ? "100vw" : `calc((100vw - ${columns - 1}rem) / ${columns})`;
}

/**
 * Make a same-origin media URL absolute so Astro's image service can optimize it.
 *
 * Astro only optimizes absolute http(s) URLs; a same-origin proxy path like
 * `/_emdash/api/media/file/x.jpg` is otherwise treated as an unoptimizable
 * public asset. Resolving it against the site's public origin (and authorizing
 * that origin via `image.remotePatterns`) lets the service transform it.
 *
 * Only **same-origin** root-relative paths are resolved. Protocol-relative
 * URLs (`//evil.com/x`) and backslash tricks (`/\evil.com`) also start with `/`
 * but resolve to a different origin -- a classic SSRF vector once a
 * remotePattern authorizes the media path -- so anything that escapes the
 * origin is returned unchanged (and then skipped by `buildResponsiveImage`,
 * which only accepts absolute http(s) URLs). Already-absolute URLs (CDN/public
 * bucket) and non-path values (`data:`, `blob:`) are returned unchanged too.
 */
export function toAbsoluteMediaUrl(src: string, origin: string | undefined): string {
	if (!src || !origin || !src.startsWith("/")) return src;
	try {
		const resolved = new URL(src, origin);
		if (resolved.origin !== new URL(origin).origin) return src;
		return resolved.href;
	} catch {
		return src;
	}
}

/**
 * Minimal structural subset of Astro's `getImage`. Astro's `ImageTransform`
 * carries a `[key: string]: any` index signature, so the real `getImage` is
 * assignable to this narrower type.
 */
export type GetImage = (options: {
	src: string;
	width?: number;
	height?: number;
	widths?: number[];
	sizes?: string;
	format?: string;
	quality?: EmbedOptions["quality"];
	[attribute: string]: unknown;
}) => Promise<{
	src: string;
	srcSet?: { attribute?: string; values?: readonly unknown[] } | undefined;
	options?: { widths?: number[] };
	attributes?: Record<string, unknown>;
}>;

/** The subset of Astro's `imageConfig` that `<Image>` applies before `getImage`. */
export interface ImageLayoutDefaults {
	layout?: string;
	objectFit?: string;
	objectPosition?: string;
}

export interface OptimizedImage {
	src: string;
	srcset?: string;
	/** Attributes for the `<img>`, including `width`, `height`, `sizes` and `loading`. */
	attributes: Record<string, unknown>;
}

/**
 * Optimize a media URL the way Astro's `<Image layout="constrained">` does,
 * with srcset candidates bounded by the source's intrinsic width.
 *
 * Astro derives constrained candidates from the display width (up to 2x) and
 * only knows the source width for bundled images, so a remote source gets
 * candidates wider than itself. Their transforms are delivered at the source
 * width (or upscaled) while the `w` descriptors claim more pixels.
 *
 * `options` holds `getImage` transform options and `<img>` attributes, as
 * `<Image>` props do. Returns `null` when the service leaves the URL unchanged
 * (unauthorized host, passthrough service) or throws, so callers render a
 * plain `<img>`.
 */
export async function optimizeImage(
	getImage: GetImage,
	imageConfig: ImageLayoutDefaults,
	options: {
		src: string;
		width: number;
		height: number;
		originalWidth?: number;
		[attribute: string]: unknown;
	},
): Promise<OptimizedImage | null> {
	const { originalWidth, ...transform } = options;
	if (!ABSOLUTE_HTTP_URL.test(transform.src)) return null;
	const layout =
		(typeof transform.layout === "string" ? transform.layout : undefined) ??
		imageConfig.layout ??
		"constrained";
	const request = {
		...transform,
		layout,
		...(layout === "none"
			? {}
			: {
					fit: transform.fit ?? imageConfig.objectFit ?? "cover",
					position: transform.position ?? imageConfig.objectPosition ?? "center",
				}),
	};
	try {
		let result = await getImage(request);
		if (!result.src || result.src === transform.src) return null;
		const widths = result.options?.widths;
		if (!transform.widths && widths?.length) {
			const capped = capCandidateWidths(widths, originalWidth);
			if (capped.length !== widths.length || capped.some((w, i) => w !== widths[i])) {
				result = await getImage({ ...request, widths: capped });
			}
		}
		const srcset = result.srcSet?.values?.length ? result.srcSet.attribute : undefined;
		return {
			src: stripInternalMediaOrigin(result.src),
			srcset: srcset ? stripInternalMediaOrigin(srcset) : undefined,
			attributes: result.attributes ?? {},
		};
	} catch {
		return null;
	}
}

/** MIME type for a transform output format, for `<source type>`. */
export function formatContentType(format: string): string {
	return `image/${format === "jpg" ? "jpeg" : format}`;
}

/** Return whether the image service rewrites the URL for this transform. */
export async function canOptimizeImage(
	getImage: GetImage,
	opts: {
		src: string;
		width: number;
		height: number;
		format?: string;
		quality?: EmbedOptions["quality"];
	},
): Promise<boolean> {
	if (!ABSOLUTE_HTTP_URL.test(opts.src)) return false;
	try {
		const result = await getImage(opts);
		return Boolean(result.src && result.src !== opts.src);
	} catch {
		return false;
	}
}

export interface ResponsiveImage {
	src: string;
	srcset?: string;
	sizes?: string;
}

/**
 * Generate a responsive `src`/`srcset`/`sizes` for a media URL via Astro's
 * configured image service.
 *
 * Astro's image services (sharp, Cloudflare `/cdn-cgi/image`, and the default
 * Cloudflare `cloudflare-binding` service) only optimize **absolute** URLs whose
 * host is authorized via `image.domains` / `image.remotePatterns`. Anything else
 * is passed through unchanged, which would yield a useless srcset (the same URL
 * at every width descriptor). We therefore only attempt optimization for
 * absolute http(s) URLs and verify the service actually rewrote the URL.
 *
 * Returns `null` so callers fall back to a plain `<img>` when:
 *  - dimensions are unknown (avoids an inferSize fetch on every render),
 *  - the URL is relative (a same-origin proxy/public asset Astro won't optimize),
 *  - the host isn't authorized (the service passed the URL through unchanged),
 *  - no image service is configured / `getImage` throws.
 */
export async function buildResponsiveImage(
	getImage: GetImage,
	opts: {
		src: string;
		width?: number;
		height?: number;
		originalWidth?: number;
		format?: string;
		quality?: EmbedOptions["quality"];
	},
): Promise<ResponsiveImage | null> {
	const { src, width, height, originalWidth, format, quality } = opts;
	if (!src || !width || !height) return null;
	if (!ABSOLUTE_HTTP_URL.test(src)) return null;
	try {
		const sizes = responsiveSizes(width);
		const result = await getImage({
			src,
			width,
			height,
			widths: responsiveWidths(width, originalWidth),
			sizes,
			format,
			...(quality !== undefined ? { quality } : {}),
		});
		// Passthrough: the service returned the source unchanged (unauthorized
		// host or no optimization available). Don't emit a no-op srcset.
		if (!result.src || result.src === src) return null;
		return {
			src: result.src,
			srcset: result.srcSet?.attribute || undefined,
			sizes,
		};
	} catch {
		return null;
	}
}
