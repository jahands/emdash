import { Sidebar } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { ContentList } from "../../src/components/ContentList.js";
import type { ContentItem, TrashedContentItem } from "../../src/lib/api";
import { PluginAdminProvider, type PluginAdmins } from "../../src/lib/plugin-context.js";
import { render } from "../utils/render.js";

const entryDate = new Intl.DateTimeFormat("en").format(new Date("2026-01-02T00:00:00Z"));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			params: _params,
			search: _search,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			params?: Record<string, string>;
			search?: Record<string, unknown>;
			[key: string]: unknown;
		}) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
	};
});

const posts: ContentItem[] = Array.from({ length: 50 }, (_, index) => ({
	id: `post-${index}`,
	type: "posts",
	slug: `post-${index}`,
	status: "draft",
	data: { title: `Post ${index}` },
	authorId: "user-1",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
}));

function pagination(totalCount: number) {
	return {
		page: 1,
		perPage: 50,
		totalCount,
		isPending: false,
		onPageChange: vi.fn(),
		onPageSizeChange: vi.fn(),
	};
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Content list pagination layout", () => {
	it("aligns a short list with the sidebar footer", async () => {
		const screen = await render(
			<div style={{ display: "flex", height: "100vh" }}>
				<aside style={{ display: "flex", flexDirection: "column", width: 260, flexShrink: 0 }}>
					<div style={{ flex: 1 }} />
					<Sidebar.Footer data-testid="sidebar-footer">My Blog</Sidebar.Footer>
				</aside>
				<main style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 24 }}>
					<ContentList
						collection="posts"
						collectionLabel="Posts"
						items={posts.slice(0, 3)}
						pagination={pagination(3)}
					/>
				</main>
			</div>,
		);
		const main = screen.getByRole("main").element();
		const footer = screen.getByRole("combobox", { name: "Page size" }).element().closest("footer")!;
		const sidebarFooter = screen.getByTestId("sidebar-footer").element().getBoundingClientRect();

		const bounds = footer.getBoundingClientRect();
		expect(main.scrollHeight).toBe(main.clientHeight);
		expect(bounds.bottom).toBeCloseTo(sidebarFooter.bottom, 0);
		expect(bounds.height).toBeCloseTo(sidebarFooter.height, 0);
	});

	it.each([
		{ width: 1280, direction: "ltr" },
		{ width: 320, direction: "rtl" },
	])(
		"keeps pagination visible while scrolling at $width px in $direction",
		async ({ width, direction }) => {
			await page.viewport(width, 800);
			const screen = await render(
				<main dir={direction} style={{ height: 600, overflowY: "auto", padding: 24 }}>
					<ContentList
						collection="posts"
						collectionLabel="Posts"
						items={posts}
						pagination={pagination(50)}
					/>
				</main>,
			);
			const main = screen.getByRole("main").element() as HTMLElement;
			const navigation = screen.getByRole("navigation", { name: "Posts pagination" }).element();
			const footer = navigation.closest("footer")!;
			const viewport = main.getBoundingClientRect();

			function expectPaginationInView() {
				expect(footer.getBoundingClientRect().bottom).toBeCloseTo(viewport.bottom, 0);
				const bounds = navigation.getBoundingClientRect();
				expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
				expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
				expect(bounds.left).toBeGreaterThanOrEqual(viewport.left);
				expect(bounds.right).toBeLessThanOrEqual(viewport.right);
			}

			expect(main.scrollHeight).toBeGreaterThan(main.clientHeight);
			expectPaginationInView();

			const link = screen
				.getByRole("link", { name: "Post 12", exact: true })
				.element() as HTMLElement;
			main.scrollTop +=
				link.getBoundingClientRect().bottom - footer.getBoundingClientRect().top - 10;
			link.focus();
			expect(link.getBoundingClientRect().bottom).toBeLessThanOrEqual(
				footer.getBoundingClientRect().top,
			);

			main.scrollTop = main.scrollHeight;
			expectPaginationInView();
			const lastTitle = screen.getByRole("link", { name: "Post 49", exact: true }).element();
			expect(lastTitle.getBoundingClientRect().bottom).toBeLessThan(
				footer.getBoundingClientRect().top,
			);
		},
	);
});

describe("Content list header alignment", () => {
	it.each(["ltr", "rtl"] as const)(
		"starts headers and keeps a plugin column's end alignment in %s",
		async (direction) => {
			const pluginAdmins: PluginAdmins = {
				"editorial-workflow": {
					contentListColumns: [{ id: "words", label: "Words", align: "end", cell: () => null }],
				},
			};
			const screen = await render(
				<div dir={direction}>
					<PluginAdminProvider pluginAdmins={pluginAdmins}>
						<ContentList
							collection="posts"
							collectionLabel="Posts"
							items={posts.slice(0, 1)}
							pluginStates={{ "editorial-workflow": { enabled: true } }}
						/>
					</PluginAdminProvider>
				</div>,
			);
			const textAlign = (name: string) =>
				getComputedStyle(screen.getByRole("columnheader", { name }).element()).textAlign;

			expect(textAlign("Title")).toBe("start");
			expect(textAlign("Words")).toBe("end");
		},
	);
});

describe("Content list at phone width", () => {
	const phoneItems: ContentItem[] = [
		posts[0]!,
		{
			...posts[1]!,
			status: "published",
			liveRevisionId: "rev_live",
			draftRevisionId: "rev_draft",
		},
		{ ...posts[2]!, data: { title: "Supercalifragilisticexpialidociouslyunbreakabletitle" } },
	];

	it("keeps each row's status and actions in view without scrolling sideways", async () => {
		const screen = await render(
			<div style={{ width: 272 }}>
				<ContentList
					collection="posts"
					collectionLabel="Posts"
					items={phoneItems}
					i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
					onBulkDelete={vi.fn()}
					onDelete={vi.fn()}
				/>
			</div>,
		);
		const tray = screen.getByRole("table").element().parentElement!;
		const trayBounds = tray.getBoundingClientRect();
		const titleCell = (name: string) =>
			page.elementLocator(screen.getByRole("link", { name, exact: true }).element().closest("td")!);

		expect(
			screen.getByRole("columnheader", { name: "Status", includeHidden: true }).element(),
		).not.toBeVisible();
		await expect.element(titleCell("Post 0").getByText("Draft")).toBeVisible();
		await expect.element(titleCell("Post 1").getByText("Pending changes")).toBeVisible();
		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);

		const actions = screen.getByRole("button", { name: /^Actions for / }).elements();
		expect(actions).toHaveLength(3);
		for (const button of actions) {
			const bounds = button.getBoundingClientRect();
			expect(bounds.left).toBeGreaterThanOrEqual(trayBounds.left);
			expect(bounds.right).toBeLessThanOrEqual(trayBounds.right);
		}
	});
});

describe("Content list below 42rem", () => {
	const title = "Announcing springtime collections and recommendations";

	function NarrowList({ width }: { width: number }) {
		return (
			<div style={{ width }}>
				<ContentList
					collection="posts"
					collectionLabel="Posts"
					items={[
						{
							...posts[0]!,
							status: "published",
							liveRevisionId: "rev_live",
							draftRevisionId: "rev_draft",
							locale: "fr",
							data: { title },
						},
					]}
					i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
					sort={{ field: "updatedAt", direction: "desc" }}
					onSortChange={vi.fn()}
					onBulkDelete={vi.fn()}
					onDelete={vi.fn()}
				/>
			</div>
		);
	}

	function visibleCopies(row: Element, text: string) {
		return [...row.querySelectorAll("td *")].filter(
			(element) =>
				element.textContent === text &&
				!element.firstElementChild &&
				element.checkVisibility({ visibilityProperty: true }),
		);
	}

	it("moves the status under the title and keeps title words whole at 460 px", async () => {
		const screen = await render(<NarrowList width={460} />);
		const tray = screen.getByRole("table").element().parentElement!;
		const link = screen.getByRole("link", { name: title, exact: true }).element();
		const titleCell = page.elementLocator(link.closest("td")!);

		expect(
			screen.getByRole("columnheader", { name: "Status", includeHidden: true }).element(),
		).not.toBeVisible();
		await expect.element(titleCell.getByText("Pending changes")).toBeVisible();
		for (const text of ["fr", entryDate]) {
			const copies = visibleCopies(link.closest("tr")!, text);
			expect(copies, text).toHaveLength(1);
			expect(copies[0]!.closest("td"), text).toBe(link.closest("td"));
		}
		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		await expect
			.element(screen.getByRole("button", { name: "Sort by Date, descending" }))
			.toBeVisible();

		const text = link.firstChild!;
		let start = 0;
		for (const word of title.split(" ")) {
			start = title.indexOf(word, start);
			const range = document.createRange();
			range.setStart(text, start);
			range.setEnd(text, start + word.length);
			expect(range.getClientRects(), word).toHaveLength(1);
			start += word.length;
		}
	});

	it("shows the status and date headers again at 700 px", async () => {
		const screen = await render(<NarrowList width={700} />);

		await expect.element(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
		await expect.element(screen.getByRole("columnheader", { name: "Date" })).toBeVisible();
		const titleCell = screen
			.getByRole("link", { name: title, exact: true })
			.element()
			.closest("td")!;
		for (const text of ["fr", entryDate]) {
			const copies = visibleCopies(titleCell.closest("tr")!, text);
			expect(copies, text).toHaveLength(1);
			expect(copies[0]!.closest("td"), text).not.toBe(titleCell);
		}
		expect(
			screen
				.getByRole("button", { name: "Sort by Date, descending", includeHidden: true })
				.element(),
		).not.toBeVisible();
	});

	it.each([272, 700])("names the actions column only Actions in a %i px table", async (width) => {
		const screen = await render(<NarrowList width={width} />);

		await expect
			.element(screen.getByRole("columnheader", { name: "Actions", exact: true }))
			.toBeInTheDocument();
	});
});

describe("Content list Trash tab at phone width", () => {
	it("shows each entry's locale and deleted date under its title without scrolling sideways", async () => {
		const trashed: TrashedContentItem = {
			...posts[0]!,
			locale: "fr",
			data: { title: "Trashed post" },
			deletedAt: "2026-01-02T00:00:00Z",
		};
		const screen = await render(
			<div style={{ width: 272 }}>
				<ContentList
					collection="posts"
					collectionLabel="Posts"
					items={posts.slice(0, 1)}
					trashedItems={[trashed]}
					trashedCount={1}
					i18n={{ defaultLocale: "en", locales: ["en", "fr"] }}
					onRestore={vi.fn()}
					onPermanentDelete={vi.fn()}
				/>
			</div>,
		);

		await screen.getByRole("tab", { name: /Trash/ }).click();
		const titleCell = page.elementLocator(
			screen.getByText("Trashed post", { exact: true }).element().closest("td")!,
		);
		const tray = screen.getByRole("table").element().parentElement!;

		await expect.element(titleCell.getByText("fr", { exact: true })).toBeVisible();
		await expect.element(titleCell.getByText(entryDate, { exact: true })).toBeVisible();
		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
	});
});

describe("Content list sort menu", () => {
	function SortableList({
		width,
		sort = { field: "updatedAt", direction: "desc" },
		onSortChange = vi.fn(),
	}: {
		width: number;
		sort?: { field: "title" | "updatedAt"; direction: "asc" | "desc" };
		onSortChange?: (sort: { field: string; direction: "asc" | "desc" }) => void;
	}) {
		return (
			<div style={{ width }}>
				<ContentList
					collection="posts"
					collectionLabel="Posts"
					items={posts.slice(0, 2)}
					sort={sort}
					onSortChange={onSortChange}
				/>
			</div>
		);
	}

	it("names the current sort while the sortable headers are hidden", async () => {
		const screen = await render(<SortableList width={272} />);

		await expect
			.element(screen.getByRole("button", { name: "Sort by Date, descending" }))
			.toBeVisible();
	});

	it("sorts by a newly chosen field in descending order", async () => {
		const onSortChange = vi.fn();
		const screen = await render(<SortableList width={272} onSortChange={onSortChange} />);

		await screen.getByRole("button", { name: "Sort by Date, descending" }).click();
		await screen.getByRole("menuitemradio", { name: "Status" }).click();

		expect(onSortChange).toHaveBeenCalledWith({ field: "status", direction: "desc" });
	});

	it("keeps the current field when choosing an order", async () => {
		const onSortChange = vi.fn();
		const screen = await render(<SortableList width={272} onSortChange={onSortChange} />);

		await screen.getByRole("button", { name: "Sort by Date, descending" }).click();
		await screen.getByRole("menuitemradio", { name: "Ascending" }).click();

		expect(onSortChange).toHaveBeenCalledWith({ field: "updatedAt", direction: "asc" });
	});

	it("keeps the sort when choosing the checked field or order", async () => {
		const onSortChange = vi.fn();
		const screen = await render(
			<SortableList
				width={272}
				sort={{ field: "title", direction: "asc" }}
				onSortChange={onSortChange}
			/>,
		);
		const trigger = screen.getByRole("button", { name: "Sort by Title, ascending" });

		await trigger.click();
		await screen.getByRole("menuitemradio", { name: "Title" }).click();
		expect(onSortChange).not.toHaveBeenCalled();

		if (!screen.getByRole("menu").query()) await trigger.click();
		await screen.getByRole("menuitemradio", { name: "Ascending" }).click();
		expect(onSortChange).not.toHaveBeenCalled();
	});

	it("names each group of choices by its label", async () => {
		const screen = await render(<SortableList width={272} />);

		await screen.getByRole("button", { name: "Sort by Date, descending" }).click();

		for (const [group, choice] of [
			["Sort by", "Title"],
			["Order", "Ascending"],
		] as const) {
			const item = screen.getByRole("menuitemradio", { name: choice }).element();
			expect(item.closest('[role="group"]')).toBe(
				screen.getByRole("group", { name: group }).element(),
			);
		}
	});

	it("puts the check at the end of the checked choice in right-to-left locales", async () => {
		document.documentElement.dir = "rtl";
		try {
			const screen = await render(
				<div dir="rtl">
					<SortableList width={272} sort={{ field: "title", direction: "asc" }} />
				</div>,
			);

			await screen.getByRole("button", { name: "Sort by Title, ascending" }).click();
			const item = screen.getByRole("menuitemradio", { name: "Title" }).element();
			const label = document.createRange();
			label.selectNodeContents(item.firstChild!);
			const labelBounds = label.getBoundingClientRect();
			const indicator = item.querySelector("svg")!.getBoundingClientRect();
			const itemBounds = item.getBoundingClientRect();
			const paddingLeft = Number.parseFloat(getComputedStyle(item).paddingLeft);

			expect(indicator.right).toBeLessThanOrEqual(labelBounds.left);
			expect(indicator.left).toBeCloseTo(itemBounds.left + paddingLeft, 0);
		} finally {
			document.documentElement.removeAttribute("dir");
		}
	});

	it("leaves sorting to the headers on a wide table", async () => {
		const screen = await render(<SortableList width={900} />);

		await expect.element(screen.getByRole("button", { name: "Date" })).toBeVisible();
		expect(
			screen
				.getByRole("button", { name: "Sort by Date, descending", includeHidden: true })
				.element(),
		).not.toBeVisible();
	});
});

describe("Content list row selection layout", () => {
	const manyPosts: ContentItem[] = Array.from({ length: 60 }, (_, index) => ({
		...posts[0]!,
		id: `many-${index}`,
		slug: `many-${index}`,
		data: { title: `Entry ${index}` },
	}));

	function SelectableList({ items = posts.slice(0, 5) }: { items?: ContentItem[] }) {
		return (
			<ContentList
				collection="posts"
				collectionLabel="Posts"
				items={items}
				pagination={{ ...pagination(items.length), perPage: 100 }}
				onSearchChange={vi.fn()}
				onStatusFilterChange={vi.fn()}
				onAuthorFilterChange={vi.fn()}
				authors={[{ id: "user-1", name: "Ada", email: "ada@example.com", avatarUrl: null }]}
				onDateFilterChange={vi.fn()}
				onBulkPublish={vi.fn(async () => [])}
				onBulkUnpublish={vi.fn(async () => [])}
				onBulkDelete={vi.fn(async () => [])}
				bulkTagTaxonomies={[{ name: "tags", label: "Tags", labelSingular: "Tag" }]}
			/>
		);
	}

	/** The rectangles of the table and of every row's cells. */
	function tableGeometry(table: Element) {
		return [table, ...table.querySelectorAll("tbody td")].map((el) => {
			const { x, y, width, height } = el.getBoundingClientRect();
			return { x, y, width, height };
		});
	}

	function expectSameGeometry(actual: DOMRectInit[], expected: DOMRectInit[]) {
		expect(actual).toHaveLength(expected.length);
		actual.forEach((rect, index) => {
			for (const key of ["x", "y", "width", "height"] as const) {
				expect(
					Math.abs(rect[key]! - expected[index]![key]!),
					`${key} of box ${index}`,
				).toBeLessThan(1);
			}
		});
	}

	it.each([
		{ width: 1280, direction: "ltr" },
		{ width: 390, direction: "ltr" },
		{ width: 390, direction: "rtl" },
	])(
		"keeps the rows in place while selecting and clearing at $width px in $direction",
		async ({ width, direction }) => {
			await page.viewport(width, 800);
			const screen = await render(
				<div dir={direction} style={{ padding: 16 }}>
					<SelectableList />
				</div>,
			);
			const table = screen.getByRole("table").element();
			const before = tableGeometry(table);
			const moveToTrash = screen.getByRole("button", { name: "Move to trash" });

			expect(moveToTrash.query()).toBeNull();

			await screen.getByRole("checkbox", { name: "Select Post 0" }).click();
			await expect.element(moveToTrash).toBeVisible();
			await expect.element(screen.getByText("1 selected")).toBeVisible();
			expectSameGeometry(tableGeometry(table), before);

			await screen.getByRole("checkbox", { name: "Select Post 1" }).click();
			await expect.element(screen.getByText("2 selected")).toBeVisible();
			expectSameGeometry(tableGeometry(table), before);

			await screen.getByRole("button", { name: "Clear", exact: true }).click();
			await expect.poll(() => moveToTrash.query()).toBeNull();
			expectSameGeometry(tableGeometry(table), before);

			await screen.getByRole("checkbox", { name: "Select Post 2" }).click();
			await screen.getByRole("checkbox", { name: "Select Post 2" }).click();
			await expect.poll(() => moveToTrash.query()).toBeNull();
			expectSameGeometry(tableGeometry(table), before);
		},
	);

	it("keeps the rows in place when the selection passes the tagging limit", async () => {
		await page.viewport(390, 800);
		const screen = await render(<SelectableList items={manyPosts} />);
		const table = screen.getByRole("table").element();
		const before = tableGeometry(table);

		await screen.getByRole("checkbox", { name: "Select all on this page" }).click();

		await expect
			.element(screen.getByRole("status").getByText("Select up to 50 posts at a time."))
			.toBeVisible();
		expectSameGeometry(tableGeometry(table), before);
	});

	it("hides the search and filters from keyboard and screen readers while rows are selected", async () => {
		const screen = await render(<SelectableList />);
		const search = screen.getByRole("searchbox", { name: "Search posts" });

		await screen.getByRole("checkbox", { name: "Select Post 0" }).click();

		expect(search.query()).toBeNull();
		expect(
			screen
				.getByRole("searchbox", { name: "Search posts", includeHidden: true })
				.element()
				.closest("[inert]"),
		).not.toBeNull();
	});

	it("moves focus to the search box when Clear is pressed from the keyboard", async () => {
		const screen = await render(<SelectableList />);

		await screen.getByRole("checkbox", { name: "Select Post 0" }).click();
		const clear = screen
			.getByRole("button", { name: "Clear", exact: true })
			.element() as HTMLElement;
		clear.focus();
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByRole("searchbox", { name: "Search posts" })).toHaveFocus();
	});
});

describe("Content list filters while authors load", () => {
	it.each(["ltr", "rtl"] as const)(
		"keeps the filters in place when the authors arrive in %s",
		async (direction) => {
			await page.viewport(390, 800);
			const props = {
				collection: "posts",
				collectionLabel: "Posts",
				items: posts.slice(0, 3),
				onSearchChange: vi.fn(),
				onStatusFilterChange: vi.fn(),
				onAuthorFilterChange: vi.fn(),
				onDateFilterChange: vi.fn(),
			};
			const screen = await render(
				<div dir={direction}>
					<ContentList {...props} />
				</div>,
			);
			const controls = () =>
				[
					screen.getByRole("combobox", { name: "Filter by status" }),
					screen.getByRole("combobox", { name: "Date field to filter on" }),
				].map((control) => {
					const { x, y } = control.element().getBoundingClientRect();
					return { x, y };
				});
			const before = controls();
			const authorFilter = screen.getByRole("combobox", { name: "Filter by author" });
			await expect.element(authorFilter).toBeDisabled();

			await screen.rerender(
				<div dir={direction}>
					<ContentList
						{...props}
						authors={[{ id: "user-1", name: "Ada", email: "ada@example.com", avatarUrl: null }]}
					/>
				</div>,
			);

			await expect.element(authorFilter).toBeEnabled();
			expect(controls()).toEqual(before);
		},
	);
});

describe("Content list while its first page loads", () => {
	it.each([
		{ width: 1280, direction: "ltr" },
		{ width: 390, direction: "rtl" },
	])(
		"records no layout shift when the rows arrive at $width px in $direction",
		async ({ width, direction }) => {
			await page.viewport(width, 800);
			const loading = { ...pagination(0), isPending: true };
			const props = {
				collection: "posts",
				collectionLabel: "Posts",
				onSearchChange: vi.fn(),
				onStatusFilterChange: vi.fn(),
				onBulkDelete: vi.fn(async () => []),
			};
			const shell = (list: React.ReactNode) => (
				<div dir={direction} style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
					{width > 768 && <aside style={{ width: 260, flexShrink: 0 }} />}
					<div style={{ display: "flex", flex: 1, flexDirection: "column", overflow: "hidden" }}>
						<header style={{ height: 52, flexShrink: 0 }} />
						<main style={{ flex: 1, overflowY: "auto", padding: 24 }}>{list}</main>
					</div>
				</div>
			);
			const screen = await render(
				shell(<ContentList {...props} items={[]} isLoading pagination={loading} />),
			);
			await expect.element(screen.getByText("Loading...")).toBeVisible();
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));

			const shifts: PerformanceEntry[] = [];
			const observer = new PerformanceObserver((list) => shifts.push(...list.getEntries()));
			observer.observe({ type: "layout-shift" });
			try {
				await screen.rerender(
					shell(
						<ContentList
							{...props}
							items={posts.slice(0, 20)}
							pagination={{ ...pagination(61), perPage: 20 }}
						/>,
					),
				);
				await expect
					.element(screen.getByRole("link", { name: "Post 0", exact: true }))
					.toBeVisible();
				await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));
				shifts.push(...observer.takeRecords());
			} finally {
				observer.disconnect();
			}

			interface ShiftSource {
				node?: Node | null;
				previousRect: DOMRectReadOnly;
				currentRect: DOMRectReadOnly;
			}
			const box = (rect: DOMRectReadOnly) =>
				[rect.x, rect.y, rect.width, rect.height].map(Math.round).join(",");
			const moved = shifts.flatMap((entry) =>
				((entry as PerformanceEntry & { sources?: ShiftSource[] }).sources ?? []).map(
					(source) =>
						`${source.node instanceof Element ? source.node.outerHTML.slice(0, 60) : "?"} ${box(source.previousRect)} -> ${box(source.currentRect)}`,
				),
			);
			expect(moved).toEqual([]);
		},
	);
});
