/**
 * Sidebar navigation the way a person does it. On phones that means tapping
 * the header menu button, tapping a link in the sheet, and then expecting the
 * sheet to have closed over the new page.
 */

const MENU_CLOSE_TIMEOUT_MS = 3000;

const PHONE_SHEET = '.emdash-sidebar[data-mobile="true"]';
const TRAILING_SLASHES = /\/+$/;

const samePath = (a, b) => a.replace(TRAILING_SLASHES, "") === b.replace(TRAILING_SLASHES, "");

/**
 * Describes what still covers the page, or returns null when the phone sheet
 * is off-screen and the middle of `main` (and its first heading, if any)
 * receives taps.
 */
function obstruction(sheetSelector) {
	const sheet = document.querySelector(sheetSelector);
	if (sheet) {
		const box = sheet.getBoundingClientRect();
		if (box.right > 1 && box.left < innerWidth - 1)
			return `the menu is still open (state ${sheet.getAttribute("data-state")}, covering x ${Math.round(Math.max(0, box.left))}-${Math.round(Math.min(innerWidth, box.right))} of ${innerWidth}px)`;
	}
	const main = document.querySelector("main");
	if (!main) return "the page has no main element";
	const heading = main.querySelector("h1");
	for (const element of heading ? [main, heading] : [main]) {
		const box = element.getBoundingClientRect();
		const left = Math.max(0, box.left);
		const right = Math.min(innerWidth, box.right);
		const top = Math.max(0, box.top);
		const bottom = Math.min(innerHeight, box.bottom);
		if (right <= left || bottom <= top) return `${element.tagName.toLowerCase()} is off-screen`;
		const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
		if (!hit || !element.contains(hit)) {
			const name = hit
				? `${hit.tagName.toLowerCase()}${hit.classList[0] ? `.${hit.classList[0]}` : ""}`
				: "nothing";
			return `${element.tagName.toLowerCase()} is covered by ${name}`;
		}
	}
	return null;
}

/**
 * Opens the page behind a sidebar link and, on phones, fails unless the menu
 * closed and the new page is visible and unobstructed afterwards.
 */
export async function openFromSidebar(page, viewportName, link, { timeout } = {}) {
	if (viewportName !== "mobile") {
		await link.click({ timeout });
		return;
	}
	await page.locator('header [data-sidebar="trigger"]').first().tap({ timeout });
	await page.locator(`${PHONE_SHEET}[data-state="expanded"]`).waitFor({ timeout });
	const href = await link.getAttribute("href", { timeout });
	const label = (await link.innerText({ timeout })).trim().split("\n")[0];
	await link.tap({ timeout });
	if (href) {
		const path = new URL(href, page.url()).pathname;
		await page.waitForURL((url) => samePath(url.pathname, path), { timeout, waitUntil: "commit" });
	}
	// Polled from Node: the admin's CSP blocks string predicates, and a reload
	// after a missing chunk replaces the page's execution context.
	const deadline = Date.now() + MENU_CLOSE_TIMEOUT_MS;
	let problem;
	do {
		problem = await page
			.evaluate(obstruction, PHONE_SHEET)
			.catch((error) => `the page could not be read (${error.message.split("\n")[0]})`);
		if (problem === null) return;
		await page.waitForTimeout(50);
	} while (Date.now() < deadline);
	throw new Error(`After tapping "${label}" in the phone menu, ${problem}`);
}
