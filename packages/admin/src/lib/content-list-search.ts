import type { BylineFilterState } from "../components/BylineFilter.js";
import type {
	ContentDateFilter,
	ContentListSort,
	ContentStatusFilter,
} from "../components/ContentList.js";

export interface ContentListSearch {
	locale?: string;
	page?: number;
	perPage?: number;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Parses the content list's URL search. Anything invalid falls back to the list's default. */
export function parseContentListSearch(search: Record<string, unknown>): ContentListSearch {
	return {
		locale: typeof search.locale === "string" ? search.locale : undefined,
		page: positiveInteger(search.page),
		perPage: positiveInteger(search.perPage),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isString(value: unknown): value is string {
	return typeof value === "string";
}

export function isContentListSort(value: unknown): value is ContentListSort | null {
	return (
		value === null ||
		(isRecord(value) &&
			typeof value.field === "string" &&
			(value.direction === "asc" || value.direction === "desc"))
	);
}

const STATUS_FILTERS = new Set<unknown>(["all", "published", "draft", "scheduled", "archived"]);

export function isContentStatusFilter(value: unknown): value is ContentStatusFilter {
	return STATUS_FILTERS.has(value);
}

const DATE_FIELDS = new Set<unknown>(["createdAt", "updatedAt", "publishedAt"]);

export function isContentDateFilter(value: unknown): value is ContentDateFilter {
	return (
		isRecord(value) &&
		DATE_FIELDS.has(value.field) &&
		typeof value.from === "string" &&
		typeof value.to === "string"
	);
}

export function isBylineFilterState(value: unknown): value is BylineFilterState {
	return (
		isRecord(value) &&
		Array.isArray(value.bylineIds) &&
		value.bylineIds.every(isString) &&
		typeof value.none === "boolean" &&
		typeof value.includeInferred === "boolean"
	);
}
