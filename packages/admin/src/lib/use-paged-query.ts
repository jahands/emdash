import {
	hashKey,
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

interface UsePagedQueryOptions<T> {
	/**
	 * Leading key segments shared by every page of this list. While a page
	 * loads, the previous page stays on screen only if it came from the same
	 * scope, so switching collections never shows another collection's rows.
	 */
	scope: QueryKey;
	/** The rest of the key: filters, search and sort. Any change returns to page 1. */
	queryKey: QueryKey;
	queryFn: (page: { page: number; perPage: number }) => Promise<PagedResult<T>>;
	/** Offered page sizes; the first is the default. */
	pageSizes: readonly number[];
	enabled?: boolean;
	/**
	 * Keeps the page and page size in step with state held outside the hook, such as the
	 * URL. `page` and `perPage` are the current external values (`undefined` when absent);
	 * `onChange` receives every change the hook makes, with `replace` true when the user
	 * did not ask for it, as when a filter changes the list or the page no longer exists.
	 */
	sync?: {
		page: number | undefined;
		perPage: number | undefined;
		onChange: (position: PagePosition, options: { replace: boolean }) => void;
	};
}

export interface PagePosition {
	page: number;
	perPage: number;
}

const NO_ITEMS: never[] = [];

/**
 * One server page of a list at a time, with the state the shared pagination
 * footer needs.
 */
export function usePagedQuery<T>({
	scope,
	queryKey,
	queryFn,
	pageSizes,
	enabled,
	sync,
}: UsePagedQueryOptions<T>) {
	const defaultPerPage = pageSizes[0] ?? 20;
	const syncedPosition: PagePosition | undefined = sync && {
		page: sync.page ?? 1,
		perPage:
			sync.perPage !== undefined && pageSizes.includes(sync.perPage)
				? sync.perPage
				: defaultPerPage,
	};
	const [localPerPage, setLocalPerPage] = React.useState(syncedPosition?.perPage ?? defaultPerPage);
	const [seenPosition, setSeenPosition] = React.useState(syncedPosition);
	const positionChanged =
		syncedPosition &&
		seenPosition &&
		(syncedPosition.page !== seenPosition.page || syncedPosition.perPage !== seenPosition.perPage);
	const perPage = positionChanged ? syncedPosition.perPage : localPerPage;
	if (positionChanged) {
		setSeenPosition(syncedPosition);
		setLocalPerPage(syncedPosition.perPage);
	}

	const resetKey = hashKey([...scope, ...queryKey, perPage]);
	const [pageState, setPageState] = React.useState({ resetKey, page: syncedPosition?.page ?? 1 });
	let page = pageState.page;
	if (positionChanged) {
		page = syncedPosition.page;
		setPageState({ resetKey, page });
	} else if (pageState.resetKey !== resetKey) {
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
		queryKey: [...scope, ...queryKey, { page, perPage }],
		queryFn: () => queryFn({ page, perPage }),
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

	const userChangedPosition = React.useRef(false);
	const onSyncChange = React.useRef(sync?.onChange);
	onSyncChange.current = sync?.onChange;
	const syncedPage = syncedPosition?.page;
	const syncedPerPage = syncedPosition?.perPage;
	React.useEffect(() => {
		if (syncedPage === undefined || (page === syncedPage && perPage === syncedPerPage)) return;
		onSyncChange.current?.({ page, perPage }, { replace: !userChangedPosition.current });
		userChangedPosition.current = false;
	}, [page, perPage, syncedPage, syncedPerPage]);

	const pagination: ListPagination = {
		page: isRecovering ? lastPage : page,
		perPage,
		totalCount,
		isPending,
		onPageChange(nextPage) {
			if (isPending || !Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > lastPage) {
				return;
			}
			userChangedPosition.current = true;
			setPageState({ resetKey, page: nextPage });
		},
		onPageSizeChange(nextPerPage) {
			if (isPending || !pageSizes.includes(nextPerPage)) return;
			userChangedPosition.current = true;
			setLocalPerPage(nextPerPage);
		},
	};

	return {
		query,
		items: isRecovering ? NO_ITEMS : (query.data?.items ?? NO_ITEMS),
		pagination,
	};
}
