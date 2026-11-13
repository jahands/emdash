/**
 * The file an image shows: for a `/_image` rendition, the root-relative path and
 * query of its source, otherwise its `src` as written.
 */
export function shownFile(image: Element | null | undefined): string | null {
	const src = image?.getAttribute("src");
	if (!src) return null;
	const url = new URL(src, window.location.origin);
	if (url.pathname !== "/_image") return src;
	const href = new URL(url.searchParams.get("href")!, window.location.origin);
	return href.pathname + href.search;
}

/** The width a `/_image` rendition asks for, or null when the image isn't a rendition. */
export function renditionWidth(image: Element | null | undefined): number | null {
	const src = image?.getAttribute("src");
	if (!src) return null;
	const url = new URL(src, window.location.origin);
	return url.pathname === "/_image" ? Number(url.searchParams.get("w")) : null;
}
