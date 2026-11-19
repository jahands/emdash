import { test, expect } from "../fixtures";

test("keeps the admin working when a plugin's icon can't load", async ({ admin, page }) => {
	await admin.devBypassAuth();
	await page.route(/phosphor-icons_react_ssr/, (route) => route.abort("internetdisconnected"));

	await admin.goto("/");

	await expect(page.locator("astro-island aside")).toBeVisible({ timeout: 15000 });
	await expect(page.getByRole("link", { name: "Denied authority" })).toBeVisible();
	await expect(page.getByText("Something went wrong")).toHaveCount(0);
});
