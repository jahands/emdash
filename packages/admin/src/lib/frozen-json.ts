const frozenValues = new WeakSet<object>();

/**
 * Deep-freezes a JSON value and remembers it, so a cache keyed by the identity
 * of a value from `isFrozenJson` can never hold a stale result.
 */
export function freezeJson<T>(value: T): T {
	if (typeof value !== "object" || value === null || frozenValues.has(value)) return value;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
	frozenValues.add(value);
	return value;
}

export function isFrozenJson(value: unknown): value is object {
	return typeof value === "object" && value !== null && frozenValues.has(value);
}

const textOfFrozenValues = new WeakMap<object, string>();

function stringifyItems(items: unknown[]): string {
	let text = "[";
	for (let index = 0; index < items.length; index++) {
		if (index > 0) text += ",";
		text += stringifyJson(items[index]) ?? "null";
	}
	return `${text}]`;
}

/**
 * `JSON.stringify`, reusing the text of frozen values, in arrays as well. A
 * list that keeps most of its frozen items is serialized by joining their text.
 */
export function stringifyJson(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return JSON.stringify(value);
	const cached = textOfFrozenValues.get(value);
	if (cached !== undefined) return cached;
	const text = Array.isArray(value) ? stringifyItems(value) : JSON.stringify(value);
	if (text !== undefined && frozenValues.has(value)) textOfFrozenValues.set(value, text);
	return text;
}
