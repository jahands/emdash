import type { ContentDateFilter } from "./ContentList.js";

/** An empty (inactive) date filter, defaulting to the created-at column. */
export const EMPTY_DATE_FILTER: ContentDateFilter = { field: "createdAt", from: "", to: "" };

export const CONTENT_LIST_PAGE_SIZES = [20, 50, 100];
