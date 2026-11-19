import {
	hashKey,
	queryOptions,
	useQuery,
	type PlaceholderDataFunction,
	type QueryKey,
} from "@tanstack/react-query";
import * as React from "react";

import type { ListPagination } from "../components/ListPaginationFooter.js";

export interface PagedResult<T> {
	items: T[];
	/** Every row matching the query, across all pages. */
	total?: number;
}

export interface PagedQuery<T> {
	/**
	 * Leading key segments shared by every page of this list. While a page
	 * loads, the previous page stays on screen only if it came from the same
	 * scope, so switching collections never shows another collection's rows.
	 */
	scope: QueryKey;
	/** The rest of the key: filters, search and sort. Any change returns to page 1. */
	queryKey: QueryKey;
	queryFn: (page: { page: number; perPage: number }) => Promise<PagedResult<T>>;
	/** Realtime topics whose changes refetch the list. */
	live?: readonly string[];
}

interface UsePagedQueryOptions<T> extends PagedQuery<T> {
	/** Offered page sizes; the first is the default. */
	pageSizes: readonly number[];
	enabled?: boolean;
}

const NO_ITEMS: never[] = [];

/** The query for one page of `list`. */
export function pagedQueryOptions<T>(list: PagedQuery<T>, page: number, perPage: number) {
	const queryKey: QueryKey = [...list.scope, ...list.queryKey, { page, perPage }];
	return queryOptions({
		queryKey,
		queryFn: () => list.queryFn({ page, perPage }),
		meta: list.live ? { live: list.live } : undefined,
	});
}

/** The page size a list shows until the user picks another. */
export function defaultPageSize(pageSizes: readonly number[]): number {
	return pageSizes[0] ?? 20;
}

/**
 * One server page of a list at a time, with the state the shared pagination
 * footer needs.
 */
export function usePagedQuery<T>({
	scope,
	queryKey,
	queryFn,
	live,
	pageSizes,
	enabled,
}: UsePagedQueryOptions<T>) {
	const [perPage, setPerPage] = React.useState(() => defaultPageSize(pageSizes));
	const resetKey = hashKey([...scope, ...queryKey, perPage]);
	const [pageState, setPageState] = React.useState({ resetKey, page: 1 });
	let page = pageState.page;
	if (pageState.resetKey !== resetKey) {
		page = 1;
		setPageState({ resetKey, page: 1 });
	}

	const scopeHash = hashKey(scope);
	const scopeLength = scope.length;
	const placeholderData = React.useCallback<PlaceholderDataFunction<PagedResult<T>>>(
		(previousData, previousQuery) =>
			previousQuery && hashKey(previousQuery.queryKey.slice(0, scopeLength)) === scopeHash
				? previousData
				: undefined,
		[scopeHash, scopeLength],
	);
	const query = useQuery({
		...pagedQueryOptions({ scope, queryKey, queryFn, live }, page, perPage),
		placeholderData,
		enabled,
	});

	const totalCount = query.data?.total ?? 0;
	const lastPage = Math.max(1, Math.ceil(totalCount / perPage));
	const isRecovering = query.isSuccess && !query.isPlaceholderData && page > lastPage;
	React.useEffect(() => {
		if (isRecovering) setPageState({ resetKey, page: lastPage });
	}, [isRecovering, lastPage, resetKey]);
	const isPending = query.isLoading || query.isPlaceholderData || isRecovering;

	const pagination: ListPagination = {
		page: isRecovering ? lastPage : page,
		perPage,
		totalCount,
		isPending,
		onPageChange(nextPage) {
			if (isPending || !Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > lastPage) {
				return;
			}
			setPageState({ resetKey, page: nextPage });
		},
		onPageSizeChange(nextPerPage) {
			if (isPending || !pageSizes.includes(nextPerPage)) return;
			setPerPage(nextPerPage);
		},
	};

	return {
		query,
		items: isRecovering ? NO_ITEMS : (query.data?.items ?? NO_ITEMS),
		pagination,
	};
}
