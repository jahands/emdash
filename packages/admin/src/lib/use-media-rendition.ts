import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { ApiResponseError } from "./api/client.js";
import { fetchMediaItemBatched } from "./api/media.js";
import { renditionWidthFor } from "./media-utils.js";

/**
 * A local media item's metadata, fetched together with every other item the
 * screen asks for at the same time. A missing item is not retried.
 */
export function useMediaItem(mediaId: string | null) {
	return useQuery({
		queryKey: ["media", mediaId],
		queryFn: () => fetchMediaItemBatched(mediaId!),
		enabled: mediaId !== null,
		retry: (failureCount, error) =>
			!(error instanceof ApiResponseError && error.status === 404) && failureCount < 1,
	});
}

/**
 * Measures the element given to the returned ref, or its parent with
 * `measure: "parent"` or while the element has no box of its own, and returns
 * the rendition width that fills that box on this screen (see
 * {@link renditionWidthFor}), or undefined until it has a size. The box
 * measured must take its size from the layout, not from the picture shown.
 * The width only grows, so a box that shrinks keeps the rendition it already
 * has. An image given to the ref stops downloading once React removes it.
 */
export function useRenditionWidth<T extends HTMLElement>(options: {
	fit?: "cover" | "contain";
	measure?: "self" | "parent";
	sourceWidth?: number | null;
	sourceHeight?: number | null;
}): [ref: (element: T | null) => void, width: number | undefined] {
	const { fit, measure: measured = "self", sourceWidth, sourceHeight } = options;
	const [element, setElement] = React.useState<T | null>(null);
	const [width, setWidth] = React.useState<number>();

	React.useLayoutEffect(() => {
		const parent = element?.parentElement;
		if (!element || !parent) return;
		const measure = () => {
			const ownBox = { width: element.offsetWidth, height: element.offsetHeight };
			const box =
				measured === "parent" || ownBox.width <= 0
					? { width: parent.clientWidth, height: parent.clientHeight }
					: ownBox;
			if (box.width <= 0) return;
			const next = renditionWidthFor(box, { fit, sourceWidth, sourceHeight });
			setWidth((current) =>
				current !== undefined && current >= next && (!sourceWidth || current <= sourceWidth)
					? current
					: next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		observer.observe(parent);
		return () => observer.disconnect();
	}, [element, fit, measured, sourceWidth, sourceHeight]);

	// Chromium can keep downloading an image React has removed until its `src` changes, and on
	// HTTP/1.1 those downloads hold the connections the next screen needs. Passive cleanups
	// run after React detaches the DOM, so an image still connected is staying (Fast Refresh
	// re-running effects) and must keep its picture.
	React.useEffect(() => {
		if (!(element instanceof HTMLImageElement)) return;
		return () => {
			if (!element.isConnected) element.removeAttribute("src");
		};
	}, [element]);

	return [setElement, width];
}

/**
 * The `src` to show for an image that is preferably shown as `rendition`: the
 * rendition, or `original` once a rendition of that file version has failed to
 * load, for every size asked for after it. Pass the returned handler to the
 * image's `onError`; it returns false when there is nothing left to try.
 */
export function useRenditionFallback(
	rendition: string | undefined,
	original: string | undefined,
): [src: string | undefined, handleError: () => boolean] {
	const [failedOriginal, setFailedOriginal] = React.useState<string>();
	const src = original !== undefined && failedOriginal === original ? original : rendition;
	const handleError = () => {
		if (src === undefined || original === undefined || src === original) return false;
		setFailedOriginal(original);
		return true;
	};
	return [src, handleError];
}
