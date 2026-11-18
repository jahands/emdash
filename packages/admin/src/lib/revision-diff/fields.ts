import { getFieldLabel } from "../field-label.js";
import { diffBlocks } from "./blocks.js";
import type { DiffContext } from "./context.js";
import { normalizeBlocks } from "./normalize.js";
import { diffText, plainRuns } from "./text-diff.js";
import { tokenizeValue, tokenizeWords } from "./tokens.js";
import type {
	ChangeStatus,
	DiffFieldDescriptor,
	FieldDiff,
	RevisionData,
	RevisionDiff,
} from "./types.js";
import { fieldMode, isEmptyValue, slugOf, stagedReferences, textOf, valueKey } from "./values.js";

const NO_BLOCKS: readonly unknown[] = [];

export function diffFields(
	previous: RevisionData,
	current: RevisionData,
	fields: Readonly<Record<string, DiffFieldDescriptor>>,
	context: DiffContext,
): FieldDiff[] {
	return Object.entries(fields).map(([slug, descriptor]) =>
		diffField(slug, descriptor, previous, current, context),
	);
}

function diffField(
	slug: string,
	descriptor: DiffFieldDescriptor,
	previous: RevisionData,
	current: RevisionData,
	context: DiffContext,
): FieldDiff {
	const mode = fieldMode(descriptor);
	const before = previous[slug];
	const after = current[slug];
	const base = {
		slug,
		label: getFieldLabel(slug, descriptor),
		kind: descriptor.kind,
		targetId: `f-${slug}`,
	};

	if (mode === "relation") {
		const staged = stagedReferences(current, "_references", slug);
		const baseline =
			stagedReferences(previous, "_references", slug) ??
			stagedReferences(current, "_referencesBaseline", slug);
		// A save only stages the references it changed, so a missing list means "as before".
		const status =
			staged === undefined
				? "unchanged"
				: statusOf(valueKey("value", baseline), valueKey("value", staged));
		return { ...base, type: "value", status, before: baseline ?? null, after: staged ?? null };
	}

	const status = statusOf(valueKey(mode, before), valueKey(mode, after));
	if (mode === "text" || mode === "url") {
		const oldText = textOf(before);
		const newText = textOf(after);
		if (oldText !== undefined && newText !== undefined) {
			const tokenize =
				mode === "url" ? tokenizeValue : (text: string) => tokenizeWords(text, context.locale);
			return {
				...base,
				type: "text",
				status,
				text: diffText(plainRuns(oldText), plainRuns(newText), tokenize, context),
			};
		}
	}
	if (mode === "portableText") {
		const oldBlocks = blocksOf(before);
		const newBlocks = blocksOf(after);
		if (oldBlocks && newBlocks) {
			const rows = diffBlocks(
				normalizeBlocks(oldBlocks),
				normalizeBlocks(newBlocks),
				slug,
				context,
			);
			return { ...base, type: "portableText", status, rows };
		}
	}
	if (mode === "boolean") {
		return { ...base, type: "boolean", status, before: Boolean(before), after: Boolean(after) };
	}
	return { ...base, type: "value", status, before, after };
}

/** Null when either revision has no `_slug`: seeded and publish-time revisions don't record one. */
export function diffSlug(previous: RevisionData, current: RevisionData): RevisionDiff["slug"] {
	if (!Object.hasOwn(previous, "_slug") || !Object.hasOwn(current, "_slug")) return null;
	const before = slugOf(previous._slug);
	const after = slugOf(current._slug);
	return { status: statusOf(before, after), before, after };
}

function statusOf(before: string | null, after: string | null): ChangeStatus {
	if (before === after) return "unchanged";
	if (before === null) return "added";
	if (after === null) return "removed";
	return "changed";
}

function blocksOf(value: unknown): readonly unknown[] | undefined {
	if (isEmptyValue(value)) return NO_BLOCKS;
	return Array.isArray(value) ? value : undefined;
}
