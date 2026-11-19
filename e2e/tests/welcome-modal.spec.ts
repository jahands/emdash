import { test, expect } from "../fixtures";

const ADMIN_ROOT_PATTERN = /\/_emdash\/admin\/?$/;
const CURRENT_USER_PATTERN = "**/_emdash/api/auth/me";
const BOOT_DATA_PATTERN =
	/(<script type="application\/json" id="emdash-admin-boot">)(.*?)(<\/script>)/s;
const LONG_FIRST_NAME = "Alexanderthegreatestnameeverwritten";
const MAX_LINE_BOX_OVERLAP_RATIO = 0.1;

test("wrapped welcome title lines do not collide", async ({ page }) => {
	await page.route(CURRENT_USER_PATTERN, async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}

		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				data: {
					id: "welcome-test-user",
					email: "welcome-test@emdash.local",
					name: LONG_FIRST_NAME,
					role: 50,
					isFirstLogin: true,
				},
			}),
		});
	});

	// The admin page also embeds the current user, so the first render never
	// asks /auth/me.
	await page.route(ADMIN_ROOT_PATTERN, async (route) => {
		const response = await route.fetch();
		const html = await response.text();
		await route.fulfill({
			response,
			body: html.replace(BOOT_DATA_PATTERN, (_match, open: string, json: string, close: string) => {
				const data = JSON.parse(json);
				data.currentUser = { ...data.currentUser, name: LONG_FIRST_NAME, isFirstLogin: true };
				return `${open}${JSON.stringify(data).replaceAll("<", "\\u003c")}${close}`;
			}),
		});
	});

	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.waitForURL(ADMIN_ROOT_PATTERN, { timeout: 30_000 });
	await page.waitForSelector("astro-island:not([ssr])", { timeout: 30_000 });

	const title = page.getByRole("heading", {
		name: `Welcome to EmDash, ${LONG_FIRST_NAME}!`,
	});
	await expect(title).toBeVisible({ timeout: 30_000 });

	const lineRects = await title.evaluate((element) => {
		// The heading also holds the site logo, so measure only its text.
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		let text: Node | null = null;
		while (walker.nextNode()) {
			if (walker.currentNode.textContent?.trim()) text = walker.currentNode;
		}
		range.selectNodeContents(text ?? element);
		return Array.from(range.getClientRects(), ({ top, bottom, height }) => ({
			top,
			bottom,
			height,
		}));
	});

	expect(lineRects.length).toBeGreaterThanOrEqual(2);
	for (let i = 0; i < lineRects.length - 1; i++) {
		const currentLine = lineRects[i]!;
		const nextLine = lineRects[i + 1]!;
		const overlap = Math.max(0, currentLine.bottom - nextLine.top);
		expect(overlap / currentLine.height).toBeLessThanOrEqual(MAX_LINE_BOX_OVERLAP_RATIO);
	}
});
