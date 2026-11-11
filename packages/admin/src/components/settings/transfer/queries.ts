import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import {
	fetchTransferApprovals,
	fetchTransferExports,
	fetchTransferImports,
	TRANSFER_APPROVALS_QUERY_KEY,
	TRANSFER_EXPORTS_QUERY_KEY,
	TRANSFER_IMPORTS_QUERY_KEY,
} from "../../../lib/api/transfer.js";

const RECENT_TRANSFERS = 10;
const APPROVALS_REFRESH_MS = 30_000;

export function transferExportsQueryOptions() {
	return queryOptions({
		queryKey: TRANSFER_EXPORTS_QUERY_KEY,
		queryFn: () => fetchTransferExports({ limit: RECENT_TRANSFERS }),
	});
}

export function transferImportsQueryOptions() {
	return queryOptions({
		queryKey: TRANSFER_IMPORTS_QUERY_KEY,
		queryFn: () => fetchTransferImports({ limit: RECENT_TRANSFERS }),
	});
}

export function pendingTransferApprovalsQueryOptions() {
	return infiniteQueryOptions({
		queryKey: TRANSFER_APPROVALS_QUERY_KEY,
		queryFn: ({ pageParam }) => fetchTransferApprovals({ status: "pending", cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		refetchInterval: APPROVALS_REFRESH_MS,
	});
}
