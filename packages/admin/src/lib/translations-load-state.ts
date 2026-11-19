import type { UseQueryResult } from "@tanstack/react-query";

export interface TranslationsLoadState {
	loading: boolean;
	error: boolean;
	onRetry: () => unknown;
}

/** Maps a translations query to `TranslationsPanel`'s loading, error and retry props. */
export function translationsLoadState(query: UseQueryResult): TranslationsLoadState {
	return {
		// A retry keeps `isError` until it settles; the panel shows it as loading.
		loading: query.isPending || (query.isError && query.isFetching),
		error: query.isError,
		onRetry: query.refetch,
	};
}
