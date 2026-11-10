import { QueryClient } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client.js";
import { retryAdminQuery } from "../../src/lib/query-retry.js";

describe("admin query recovery", () => {
	it.each([403, 404, 500])("only retries transient failures (%s)", async (status) => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: retryAdminQuery, retryDelay: 0 } },
		});
		const queryFn = vi.fn().mockRejectedValue(new ApiResponseError(status, "FAILURE", "Failed"));
		await expect(queryClient.fetchQuery({ queryKey: ["failed"], queryFn })).rejects.toThrow(
			"Failed",
		);
		expect(queryFn).toHaveBeenCalledTimes(status >= 500 ? 2 : 1);
		queryClient.clear();
	});
});
