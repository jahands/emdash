import { describe, expect, it, vi } from "vitest";

import { QueryErrorState } from "../../src/components/QueryErrorState.js";
import { ApiResponseError } from "../../src/lib/api/client.js";
import { render } from "../utils/render.tsx";

import "../../dist/styles.css";

describe("query recovery", () => {
	it("centers Retry under the message and retries server failures without blaming the connection", async () => {
		const retry = vi.fn();
		const screen = await render(
			<QueryErrorState
				error={new ApiResponseError(500, "INTERNAL_ERROR", "failed")}
				onRetry={retry}
			/>,
		);
		const alert = screen.getByRole("alert").element().getBoundingClientRect();
		const button = screen.getByRole("button", { name: "Retry" });
		const rect = button.element().getBoundingClientRect();
		expect(Math.abs(rect.x + rect.width / 2 - alert.x - alert.width / 2)).toBeLessThan(1);
		expect(screen.container.textContent).not.toContain("Check your connection");
		await button.click();
		expect(retry).toHaveBeenCalledOnce();
		await screen.rerender(
			<QueryErrorState error={new TypeError("Failed to fetch")} onRetry={retry} />,
		);
		await expect.element(screen.getByText("Check your connection and try again.")).toBeVisible();
	});
});
