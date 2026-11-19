export interface PositionSnapshot {
	element: Element;
	rect: DOMRect;
}

export function snapshotPositions(elements: Iterable<Element>): PositionSnapshot[] {
	return Array.from(elements, (element) => ({ element, rect: element.getBoundingClientRect() }));
}

/**
 * The farthest, in CSS pixels, any snapshotted element's box has moved since
 * the snapshot, counting resizes too unless `includeSize` is false. An element
 * that left the document counts as having moved infinitely far.
 */
export function largestMovement(
	snapshot: PositionSnapshot[],
	{ includeSize = true }: { includeSize?: boolean } = {},
): number {
	let largest = 0;
	for (const { element, rect } of snapshot) {
		if (!element.isConnected) return Number.POSITIVE_INFINITY;
		const now = element.getBoundingClientRect();
		largest = Math.max(
			largest,
			Math.abs(now.left - rect.left),
			Math.abs(now.top - rect.top),
			includeSize ? Math.abs(now.width - rect.width) : 0,
			includeSize ? Math.abs(now.height - rect.height) : 0,
		);
	}
	return largest;
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * Samples the boxes of the elements matching `selector` on every animation
 * frame until stopped, and reports the farthest any element moved from where
 * it was first drawn.
 */
export function watchMovement(selector: string) {
	const firstSeen = new Map<Element, DOMRect>();
	let largest = 0;
	let frame = 0;
	const sample = () => {
		for (const element of document.querySelectorAll(selector)) {
			const rect = element.getBoundingClientRect();
			const first = firstSeen.get(element);
			if (!first) {
				firstSeen.set(element, rect);
				continue;
			}
			largest = Math.max(largest, Math.abs(rect.left - first.left), Math.abs(rect.top - first.top));
		}
		frame = requestAnimationFrame(sample);
	};
	sample();
	return {
		stop() {
			cancelAnimationFrame(frame);
			sample();
			cancelAnimationFrame(frame);
			return largest;
		},
	};
}
