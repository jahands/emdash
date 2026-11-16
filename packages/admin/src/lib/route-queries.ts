/**
 * The first queries of screens the sidebar links to. Each screen reads its
 * data with these options and its route loader prefetches them, so hovering a
 * link loads the screen's data into the same cache entries.
 *
 * Kept out of the screens' modules: the router imports it, and the screens'
 * code loads on demand.
 *
 * `meta.live` names the realtime topics whose changes refetch a query.
 */

import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type { ContentListSort, ContentStatusFilter } from "../components/ContentList.js";
// Screens imported these from the `./api.js` barrel, which their tests mock.
import {
	fetchBlockTypes,
	fetchBylines,
	fetchCollections,
	fetchContentAuthors,
	fetchContentList,
	fetchMediaFolders,
	fetchMediaList,
	fetchMenus,
	fetchOrphanedTables,
	fetchPlugins,
	fetchSections,
	fetchUsers,
	fetchWidgetAreas,
	fetchWidgetComponents,
	type ContentDateField,
	type SectionSource,
} from "./api.js";
import { listBylineFields } from "./api/byline-fields.js";
import { fetchCommentCounts, fetchComments, type CommentStatus } from "./api/comments.js";
import { fetchDashboardStats } from "./api/dashboard.js";
import { fetchRedirects } from "./api/redirects.js";
import { fetchTaxonomyDef, fetchTerms } from "./api/taxonomies.js";
import type { PagedQuery } from "./use-paged-query.js";

export function dashboardStatsQueryOptions() {
	return queryOptions({ queryKey: ["dashboard-stats"], queryFn: fetchDashboardStats });
}

export interface ContentListFilters {
	locale: string | undefined;
	sort: ContentListSort;
	search: string;
	status: ContentStatusFilter;
	author: string;
	date: { dateField: ContentDateField; dateFrom?: string; dateTo?: string } | undefined;
	byline:
		| { bylines: string[] | undefined; bylinesNone: boolean; includeInferredBylines: boolean }
		| undefined;
	fields: string[] | undefined;
}

export function contentListQuery(
	collection: string,
	filters: ContentListFilters,
): PagedQuery<Awaited<ReturnType<typeof fetchContentList>>["items"][number]> {
	const { locale, sort, search, status, author, date, byline, fields } = filters;
	return {
		scope: ["content", collection],
		live: [`content/${collection}`],
		queryKey: [filters],
		queryFn: ({ page, perPage }) =>
			fetchContentList(collection, {
				fields,
				locale,
				page,
				limit: perPage,
				orderBy: sort.field,
				order: sort.direction,
				search: search || undefined,
				status: status === "all" ? undefined : status,
				authorId: author || undefined,
				...date,
				...byline,
				trashTotal: true,
			}),
	};
}

/**
 * Authors are collection-wide (the endpoint doesn't scope by locale), so the
 * key omits locale to avoid refetching on locale switches.
 */
export function contentAuthorsQueryOptions(collection: string) {
	return queryOptions({
		queryKey: ["content", collection, "authors"],
		queryFn: () => fetchContentAuthors(collection),
	});
}

export const MEDIA_PAGE_SIZE = 35;

export function mediaListQueryOptions(options: {
	search: string;
	mimeFilter: string | string[] | undefined;
	folder: string | undefined;
	page: number;
	perPage: number;
}) {
	const { search, mimeFilter, folder, page, perPage } = options;
	const mime = Array.isArray(mimeFilter) ? mimeFilter.join(",") : (mimeFilter ?? "");
	return queryOptions({
		queryKey: ["media", { search, mime, folder: folder ?? "main", page, perPage }],
		queryFn: () =>
			fetchMediaList({
				page,
				limit: perPage,
				search: search || undefined,
				mimeType: mimeFilter,
				folderId: search ? undefined : (folder ?? null),
			}),
	});
}

export function mediaFoldersQueryOptions(search: string) {
	return infiniteQueryOptions({
		queryKey: ["media-folders", "page", { search }],
		queryFn: ({ pageParam }) =>
			fetchMediaFolders({ limit: 100, cursor: pageParam, search: search || undefined }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
}

export function commentsQueryOptions(filters: {
	status: CommentStatus;
	collection: string;
	search: string;
}) {
	const { status, collection, search } = filters;
	return infiniteQueryOptions({
		queryKey: ["comments", status, collection, search],
		queryFn: ({ pageParam }) =>
			fetchComments({
				status,
				collection: collection || undefined,
				search: search || undefined,
				cursor: pageParam,
				limit: 50,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		meta: { live: ["comments"] },
	});
}

/** The admin page embeds these for moderators, so the sidebar and tabs show them without a request. */
export function commentCountsQueryOptions() {
	return queryOptions({
		queryKey: ["commentCounts"],
		queryFn: fetchCommentCounts,
		meta: { live: ["comments"] },
	});
}

export function menusQueryOptions(locale: string | undefined) {
	return queryOptions({
		queryKey: ["menus", locale],
		queryFn: () => fetchMenus({ locale }),
		meta: { live: ["menus"] },
	});
}

export const REDIRECT_LIST_KEY = ["redirects", "list"] as const;

export function redirectsQueryOptions(filters: {
	search: string;
	enabled: boolean | undefined;
	auto: boolean | undefined;
	group: string | undefined;
}) {
	const { search, enabled, auto, group } = filters;
	return infiniteQueryOptions({
		queryKey: [...REDIRECT_LIST_KEY, search, enabled, auto, group],
		queryFn: ({ pageParam }) =>
			fetchRedirects({
				search: search || undefined,
				group,
				enabled,
				auto,
				cursor: pageParam,
				limit: 100,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
}

export function widgetAreasQueryOptions() {
	return queryOptions({ queryKey: ["widget-areas"], queryFn: fetchWidgetAreas });
}

export function widgetComponentsQueryOptions() {
	return queryOptions({ queryKey: ["widget-components"], queryFn: fetchWidgetComponents });
}

export function sectionsQueryOptions(filters: { source: SectionSource | null; search: string }) {
	const { source, search } = filters;
	return queryOptions({
		queryKey: ["sections", { source, search }],
		queryFn: () => fetchSections({ source: source || undefined, search: search || undefined }),
	});
}

export function taxonomyDefQueryOptions(name: string) {
	return queryOptions({
		queryKey: ["taxonomy-def", name],
		queryFn: () => fetchTaxonomyDef(name),
	});
}

/**
 * The count mode belongs in the key: the editor's taxonomy picker reads the
 * same endpoint without counts, and the taxonomy screen renders them.
 */
export function taxonomyTermsQueryOptions(name: string, locale: string | undefined) {
	return queryOptions({
		queryKey: ["taxonomy-terms", name, locale, { includeCounts: true }],
		queryFn: () => fetchTerms(name, { locale }),
	});
}

export function bylinesQueryOptions(filters: {
	search: string;
	guest: "all" | "guest" | "linked";
	locale: string | undefined;
}) {
	const { search, guest, locale } = filters;
	return queryOptions({
		queryKey: ["bylines", search, guest, locale ?? null],
		queryFn: () =>
			fetchBylines({
				search: search || undefined,
				isGuest: guest === "all" ? undefined : guest === "guest",
				locale,
				limit: 50,
			}),
	});
}

export function bylineFieldsQueryOptions() {
	return queryOptions({ queryKey: ["byline-fields"], queryFn: listBylineFields });
}

export function usersQueryOptions(filters: { search: string; role: number | undefined }) {
	const { search, role } = filters;
	return infiniteQueryOptions({
		queryKey: ["users", search, role],
		queryFn: ({ pageParam }) =>
			fetchUsers({ search: search || undefined, role, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
	});
}

export function schemaCollectionsQueryOptions() {
	return queryOptions({ queryKey: ["schema", "collections"], queryFn: fetchCollections });
}

export function orphanedTablesQueryOptions() {
	return queryOptions({ queryKey: ["schema", "orphans"], queryFn: fetchOrphanedTables });
}

export function blockTypesQueryOptions() {
	return queryOptions({ queryKey: ["schema", "block-types"], queryFn: fetchBlockTypes });
}

export function pluginsQueryOptions() {
	return queryOptions({ queryKey: ["plugins"], queryFn: fetchPlugins });
}
