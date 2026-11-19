import {
	blockSignature,
	canonicalJson,
	canonicalJsonWithoutKeys,
	isRecord,
	normalizeBlocks,
	type UnknownRecord,
} from "./normalize.js";
import type { DiffFieldDescriptor, RevisionData } from "./types.js";

/** How a field's values are compared. */
export type FieldMode =
	| "text"
	| "url"
	| "portableText"
	| "boolean"
	| "number"
	| "datetime"
	| "multiSelect"
	| "media"
	| "relation"
	| "value";

export function fieldMode(descriptor: DiffFieldDescriptor): FieldMode {
	// A plugin widget can store anything, whatever the field's kind.
	if (descriptor.widget) return "value";
	switch (descriptor.kind) {
		case "string":
		case "richText":
			return "text";
		case "url":
		case "portableText":
		case "boolean":
		case "number":
		case "datetime":
		case "multiSelect":
			return descriptor.kind;
		case "image":
		case "file":
			return "media";
		case "reference":
			// A reference bound to a relation keeps its entries outside the field's own data.
			return typeof descriptor.validation?.relation === "string" && descriptor.validation.relation
				? "relation"
				: "value";
		default:
			return "value";
	}
}

/**
 * A string that is equal for two values exactly when the diff treats them as the same, or null
 * for an empty value.
 */
export function valueKey(mode: FieldMode, value: unknown): string | null {
	if (mode === "boolean") return value ? "true" : null;
	if (isEmptyValue(value)) return null;
	switch (mode) {
		case "text":
		case "url": {
			const text = textOf(value);
			if (text !== undefined) return text;
			break;
		}
		case "portableText":
			if (Array.isArray(value)) {
				return JSON.stringify(normalizeBlocks(value).map((block) => blockSignature(block)));
			}
			break;
		case "number": {
			const number = typeof value === "string" ? Number(value) : value;
			if (typeof number === "number" && Number.isFinite(number)) return String(number);
			break;
		}
		case "datetime": {
			const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
			if (!Number.isNaN(time)) return String(time);
			break;
		}
		case "multiSelect":
			if (Array.isArray(value)) {
				const options = new Set(value.map((option: unknown) => canonicalJson(option)));
				return canonicalJson([...options].toSorted());
			}
			break;
		case "media":
			return canonicalJson(mediaParts(value));
		default:
			break;
	}
	return canonicalJsonWithoutKeys(value);
}

export function slugOf(value: unknown): string | null {
	return typeof value === "string" && value ? value : null;
}

/** The translation groups a save staged for a relation-bound reference field, if any. */
export function stagedReferences(
	data: RevisionData,
	key: "_references" | "_referencesBaseline",
	slug: string,
): unknown {
	const staged = data[key];
	return isRecord(staged) ? staged[slug] : undefined;
}

export function isEmptyValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

export function textOf(value: unknown): string | undefined {
	if (isEmptyValue(value)) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	return undefined;
}

/** What identifies an image or file value; dimensions and provider metadata don't count. */
function mediaParts(value: unknown): unknown {
	if (typeof value === "string") return ["url", value];
	if (!isRecord(value)) return canonicalJsonWithoutKeys(value);
	return [
		mediaIdentity(value),
		typeof value.alt === "string" ? value.alt : "",
		typeof value.focalX === "number" ? value.focalX : null,
		typeof value.focalY === "number" ? value.focalY : null,
		isRecord(value.darkVariant) ? mediaParts(value.darkVariant) : null,
	];
}

function mediaIdentity(value: UnknownRecord): string {
	const provider = typeof value.provider === "string" && value.provider ? value.provider : "local";
	for (const candidate of [value.id, value.src, value.url]) {
		if (typeof candidate === "string" && candidate) return `${provider}:${candidate}`;
	}
	return `${provider}:`;
}
