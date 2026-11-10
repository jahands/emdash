import { onlineManager } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { ListPaginationFooter } from "../../src/components/ListPaginationFooter.js";
import { usePagedQuery } from "../../src/lib/use-paged-query.js";
import { render } from "../utils/render.tsx";

function List() {
	const { items, pagination } = usePagedQuery({
		scope: ["offline-test"],
		queryKey: [],
		pageSizes: [1],
		queryFn: async ({ page }) => ({ items: [page], total: 2 }),
	});
	return (
		<>
			<div inert={pagination.isPending || undefined}>
				{items.map((id) => (
					<button key={id}>Row {id}</button>
				))}
			</div>
			<ListPaginationFooter pagination={pagination} pageSizes={[1]} label="Pages" />
		</>
	);
}

describe("paused pagination", () => {
	it("keeps the loaded page label and rows usable while offline, then resumes", async () => {
		const screen = await render(<List />);
		await expect.element(screen.getByRole("button", { name: "Row 1" })).toBeVisible();
		try {
			onlineManager.setOnline(false);
			await screen.getByRole("button", { name: "Next page" }).click();
			await expect.element(screen.getByText(/You’re offline/)).toBeVisible();
			expect(screen.getByRole("button", { name: "Row 1" }).element().closest("[inert]")).toBeNull();
			expect(
				screen
					.getByRole("status")
					.all()
					.some((el) => el.element().textContent?.includes("Showing 1-1")),
			).toBe(true);
			onlineManager.setOnline(true);
			await expect.element(screen.getByRole("button", { name: "Row 2" })).toBeVisible();
		} finally {
			onlineManager.setOnline(true);
		}
	});
});
