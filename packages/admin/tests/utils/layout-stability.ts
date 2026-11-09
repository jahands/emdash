export interface LayoutShiftSource {
	selector: string;
	from: { x: number; y: number; width: number; height: number };
	to: { x: number; y: number; width: number; height: number };
}

export interface LayoutShift {
	value: number;
	sources: LayoutShiftSource[];
}

interface LayoutShiftEntry extends PerformanceEntry {
	value: number;
	sources?: Array<{
		node?: Node | null;
		previousRect: DOMRectReadOnly;
		currentRect: DOMRectReadOnly;
	}>;
}

function describe(node: Node | null | undefined): string {
	if (!(node instanceof Element)) return "(removed)";
	const testId = node.getAttribute("data-testid");
	if (testId) return `[data-testid="${testId}"]`;
	return `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(/\s+/).slice(0, 2).join(".")}` : ""}`;
}

function nextFrames(count: number): Promise<void> {
	return new Promise((resolve) => {
		const tick = (remaining: number) => {
			if (remaining === 0) resolve();
			else requestAnimationFrame(() => tick(remaining - 1));
		};
		tick(count);
	});
}

/**
 * Runs `change` (for example, resolving a deferred API response) and returns
 * every layout shift Chromium reports until the page has painted a few more frames.
 *
 * Render the content inside the visible area: shifts of off-screen elements
 * do not count.
 */
export async function measureLayoutShifts(
	change: () => void | Promise<void>,
): Promise<LayoutShift[]> {
	const shifts: LayoutShift[] = [];
	const collect = (entries: PerformanceEntryList) => {
		for (const entry of entries as LayoutShiftEntry[]) {
			shifts.push({
				value: entry.value,
				sources: (entry.sources ?? []).map((source) => ({
					selector: describe(source.node),
					from: source.previousRect.toJSON(),
					to: source.currentRect.toJSON(),
				})),
			});
		}
	};
	const observer = new PerformanceObserver((list) => collect(list.getEntries()));
	await nextFrames(2);
	observer.observe({ type: "layout-shift" });
	await change();
	await nextFrames(4);
	collect(observer.takeRecords());
	observer.disconnect();
	return shifts;
}

/** Fails when `change` moves any on-screen element by more than `maxShift`. */
export async function expectStableLayout(
	change: () => void | Promise<void>,
	{ maxShift = 0.001 }: { maxShift?: number } = {},
): Promise<void> {
	const shifts = await measureLayoutShifts(change);
	const total = shifts.reduce((sum, shift) => sum + shift.value, 0);
	if (total > maxShift) {
		throw new Error(
			`Expected a layout shift of at most ${maxShift}, got ${total.toFixed(4)}:\n${JSON.stringify(shifts, null, 2)}`,
		);
	}
}
