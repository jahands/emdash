const COLLAPSE_SIDEBAR = /^(Collapse|Expand) sidebar$/;
const ROW_ACTIONS = /Actions|More/;
const NEXT_PAGE = /Next page|Load more/;

const admin = (path) => `/_emdash/admin${path}`;

const sidebarTrigger = (page, viewportName) =>
	viewportName === "mobile"
		? page.locator('header [data-sidebar="trigger"]').first()
		: page.getByRole("button", { name: COLLAPSE_SIDEBAR }).first();

const sidebarLink = (page, label) =>
	page
		.locator(".emdash-sidebar a")
		.filter({ hasText: new RegExp(`^\\s*${label}`) })
		.first();

async function openSidebarOnMobile(page, viewportName) {
	const expanded = page.locator('.emdash-sidebar[data-state="expanded"]');
	if (viewportName !== "mobile" || (await expanded.count()) > 0) return;
	await sidebarTrigger(page, viewportName).click();
	await expanded.waitFor();
}

export const SCENARIOS = [
	{
		id: "scenario:nav-sections",
		async run({ page, step, viewportName }) {
			await step("load dashboard", () => page.goto(admin("/"), { waitUntil: "commit" }));
			for (const label of ["Posts", "Pages", "Media", "Comments", "Dashboard"]) {
				await step(`open ${label}`, async () => {
					await openSidebarOnMobile(page, viewportName);
					await sidebarLink(page, label).click();
				});
			}
		},
	},
	{
		id: "scenario:sidebar-toggle",
		async run({ page, step, viewportName }) {
			await step("load posts", () => page.goto(admin("/content/posts"), { waitUntil: "commit" }));
			await step("toggle sidebar", () => sidebarTrigger(page, viewportName).click());
			await step("toggle sidebar back", () =>
				viewportName === "mobile"
					? page.locator('.emdash-sidebar [data-sidebar="trigger"]').first().click()
					: sidebarTrigger(page, viewportName).click(),
			);
		},
	},
	{
		id: "scenario:command-palette",
		async run({ page, step }) {
			await step("load dashboard", () => page.goto(admin("/"), { waitUntil: "commit" }));
			await step("open palette", () => page.keyboard.press("ControlOrMeta+k"));
			await step("type query", () =>
				page.getByRole("combobox").first().pressSequentially("post", { delay: 40 }),
			);
			await step("close palette", () => page.keyboard.press("Escape"));
		},
	},
	{
		id: "scenario:list-filters",
		async run({ page, step }) {
			await step("load posts", () => page.goto(admin("/content/posts"), { waitUntil: "commit" }));
			await step("next page", () => page.getByRole("button", { name: "Next page" }).click());
			await step("previous page", () =>
				page.getByRole("button", { name: "Previous page" }).click(),
			);
			await step("open status filter", () => page.locator(".emdash-status-filter-trigger").click());
			await step("choose draft", () => page.getByRole("option", { name: "Draft" }).click());
			await step("search", () => page.locator('input[aria-label^="Search"]').fill("post"));
			await step("open trash tab", () => page.getByRole("tab", { name: "Trash" }).click());
		},
	},
	{
		id: "scenario:content-dialogs",
		async run({ page, step }) {
			await step("load posts", () => page.goto(admin("/content/posts"), { waitUntil: "commit" }));
			await step("open row menu", () =>
				page.getByRole("button", { name: ROW_ACTIONS }).first().click(),
			);
			await step("open trash confirm", () =>
				page.getByRole("menuitem", { name: "Move to trash" }).click(),
			);
			await step("cancel confirm", () => page.getByRole("button", { name: "Cancel" }).click());
			await step("open menus", () => page.goto(admin("/menus"), { waitUntil: "commit" }));
			await step("open create menu", () =>
				page.getByRole("button", { name: "Create Menu" }).first().click(),
			);
			await step("close create menu", () => page.getByRole("button", { name: "Cancel" }).click());
		},
	},
	{
		id: "scenario:editor",
		async run({ page, step, viewportName, params }) {
			await step("load editor", () =>
				page.goto(admin(`/content/posts/${params.shortPostId}`), { waitUntil: "commit" }),
			);
			const editor = page.locator(".ProseMirror").first();
			await step("focus editor", () => editor.click({ position: { x: 20, y: 20 } }));
			await step("type paragraph", () =>
				page.keyboard.type("Typing a new sentence to watch the toolbar and save state. ", {
					delay: 12,
				}),
			);
			await step("select and bold", async () => {
				await page.keyboard.press("Shift+Home");
				await page.getByRole("button", { name: "Bold", exact: true }).first().click();
			});
			if (viewportName === "mobile") {
				await step("open settings", () =>
					page.getByRole("button", { name: "Settings" }).first().click(),
				);
				await step("close settings", () =>
					page.getByRole("button", { name: "Close settings" }).click(),
				);
			} else {
				await step("enter distraction-free", () =>
					page.getByRole("button", { name: "Enter distraction-free mode" }).click(),
				);
				await step("exit distraction-free", () =>
					page.getByRole("button", { name: "Exit distraction-free mode" }).click(),
				);
			}
			await step("save", () => page.keyboard.press("ControlOrMeta+s"));
		},
	},
	{
		id: "scenario:editor-long-post",
		async run({ page, step, params }) {
			await step("load long editor", () =>
				page.goto(admin(`/content/posts/${params.longPostId}`), { waitUntil: "commit" }),
			);
			const editor = page.locator(".ProseMirror").first();
			await step("focus and type", async () => {
				await editor.click({ position: { x: 20, y: 20 } });
				await page.keyboard.type("Typing into a very long post. ", { delay: 12 });
			});
		},
	},
	{
		id: "scenario:media-library",
		async run({ page, step }) {
			await step("load media", () => page.goto(admin("/media"), { waitUntil: "commit" }));
			await step("open first item", () => page.locator("[data-media-grid] button").first().click());
			await step("close details", () => page.keyboard.press("Escape"));
			await step("list view", () => page.getByRole("tab", { name: "List view" }).click());
			await step("grid view", () => page.getByRole("tab", { name: "Grid view" }).click());
			await step("next page", async () => {
				const next = page.getByRole("button", { name: NEXT_PAGE }).first();
				if (await next.isVisible()) await next.click();
			});
		},
	},
];
