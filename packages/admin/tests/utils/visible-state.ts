export interface VisibleStateOptions {
	columns?: string;
	rows?: string;
	identityAttribute?: string;
	scroll?: string;
}

export function captureVisibleState({
	columns = "thead th",
	rows = "tbody tr",
	identityAttribute,
	scroll = "main",
}: VisibleStateOptions = {}) {
	return {
		columns: Array.from(document.querySelectorAll(columns), (element) => {
			const { x, width } = element.getBoundingClientRect();
			return { x, width };
		}),
		rows: Array.from(document.querySelectorAll(rows), (element) =>
			identityAttribute ? element.getAttribute(identityAttribute) : element.textContent,
		),
		scroll: Array.from(document.querySelectorAll(scroll), (element) => ({
			x: element.scrollLeft,
			y: element.scrollTop,
		})),
		windowScroll: { x: window.scrollX, y: window.scrollY },
	};
}

export function assertVisibleState(
	before: ReturnType<typeof captureVisibleState>,
	after: ReturnType<typeof captureVisibleState>,
	tolerance = 1,
) {
	const errors: string[] = [];
	if (JSON.stringify(before.rows) !== JSON.stringify(after.rows))
		errors.push("row identity changed");
	for (const key of ["columns", "scroll"] as const) {
		if (before[key].length !== after[key].length) errors.push(`${key} count changed`);
		before[key].forEach((value, index) => {
			for (const [dimension, number] of Object.entries(value)) {
				const actual = after[key][index] as Record<string, number> | undefined;
				if (
					!actual ||
					!Number.isFinite(actual[dimension]) ||
					Math.abs(number - actual[dimension]) > tolerance
				)
					errors.push(`${key}[${index}].${dimension} moved: ${number} -> ${actual?.[dimension]}`);
			}
		});
	}
	for (const axis of ["x", "y"] as const) {
		if (Math.abs(before.windowScroll[axis] - after.windowScroll[axis]) > tolerance)
			errors.push(`window scroll ${axis} changed`);
	}
	if (errors.length) throw new Error(`Visible state changed:\n${errors.join("\n")}`);
}
