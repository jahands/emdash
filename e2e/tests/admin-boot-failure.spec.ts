import { test, expect } from "../fixtures";

const CATALOG_REQUEST = /\/locales\/ar\/messages\.mjs|\/messages[.-][^/]*\.mjs/;
const PLUGIN_ADMINS_REQUEST = /admin-registry|emdash-admin/;

test.use({ locale: "ar" });

for (const [name, request] of [
	["the translation catalog fails", CATALOG_REQUEST],
	["plugin admins fail", PLUGIN_ADMINS_REQUEST],
] as const) {
	test(`shows a retry state in the request's language when ${name} to load, and recovers on Retry`, async ({
		admin,
		page,
	}) => {
		await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/api/auth/me");
		await page.waitForURL((url) => url.pathname === "/_emdash/api/auth/me");
		await page.request.post("/_emdash/api/auth/me", {
			headers: { "X-EmDash-Request": "1" },
			data: { action: "dismissWelcome" },
		});

		await page.route(request, (route) => route.abort("internetdisconnected"));
		await admin.goto("/");

		const alert = page.getByRole("alert");
		await expect(alert).toContainText("فشل تحميل لوحة الإدارة");
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(page.locator("#emdash-boot-loader")).toHaveCount(0);

		await page.unroute(request);
		await alert.getByRole("button", { name: "حاول مجددًا" }).click();

		await expect(page.locator("astro-island aside")).toBeVisible({ timeout: 15000 });
		await expect(page.getByText("فشل تحميل لوحة الإدارة")).toHaveCount(0);
	});
}
