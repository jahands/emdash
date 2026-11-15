import { describe, it, expect, vi, beforeEach } from "vitest";
import { page, userEvent } from "vitest/browser";

import type { Collection, ContentItem, FindManyResult } from "../../src/lib/api";
import { deferred } from "../utils/geometry.js";
import { render } from "../utils/render.tsx";

const mockFetchContentList =
	vi.fn<
		(collection: string, options?: { search?: string }) => Promise<FindManyResult<ContentItem>>
	>();
const mockFetchCollections = vi.fn<() => Promise<Collection[]>>();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchCollections: () => mockFetchCollections(),
		fetchContentList: (...args: unknown[]) =>
			mockFetchContentList(...(args as [string, { search?: string }])),
	};
});

const { ContentPickerModal } = await import("../../src/components/ContentPickerModal");

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
	return {
		id: "post-en",
		type: "posts",
		slug: "jane-doe",
		status: "published",
		locale: "en",
		translationGroup: "grp-1",
		data: { title: "Jane Doe" },
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: "2026-01-01T00:00:00Z",
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		...overrides,
	};
}

describe("ContentPickerModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchCollections.mockResolvedValue([]);
	});

	it("disables an entry already linked through another locale variant", async () => {
		// The editor is at `fr` and the reference resolved to the `fr` row, but the
		// picker's result page only carries the `en` variant of that same entry
		// (search matched the English title; the rest is behind the cursor).
		mockFetchContentList.mockResolvedValue({
			items: [makeItem()],
			nextCursor: "cursor-1",
		});

		const screen = await render(
			<ContentPickerModal
				open
				onOpenChange={() => {}}
				collection="posts"
				multiple
				locale="fr"
				selectedIds={new Set(["grp-1"])}
				onConfirm={() => {}}
			/>,
		);

		await expect.element(screen.getByText("Jane Doe")).toBeInTheDocument();
		await expect.element(screen.getByRole("checkbox", { name: "Jane Doe" })).toBeDisabled();
		await expect.element(screen.getByRole("checkbox", { name: "Jane Doe" })).toBeChecked();
	});

	it("matches by row id when no locale is given (menu picker)", async () => {
		mockFetchContentList.mockResolvedValue({ items: [makeItem()] });

		const screen = await render(
			<ContentPickerModal
				open
				onOpenChange={() => {}}
				collection="posts"
				multiple
				selectedIds={new Set(["post-en"])}
				onConfirm={() => {}}
			/>,
		);

		await expect.element(screen.getByRole("checkbox", { name: "Jane Doe" })).toBeDisabled();
	});

	it("says the list could not be loaded rather than that the collection is empty", async () => {
		mockFetchContentList.mockRejectedValue(new Error("Internal Server Error"));

		const screen = await render(
			<ContentPickerModal
				open
				onOpenChange={() => {}}
				collection="posts"
				multiple
				selectedIds={new Set()}
				onConfirm={() => {}}
			/>,
		);

		// "No content in this collection" would send an editor off to create an
		// entry that is already there.
		await expect.element(screen.getByText("Couldn't load content.")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
		expect(screen.getByText("No content in this collection").query()).toBeNull();
	});

	it("keeps the results in place while a new search loads", async () => {
		const search = deferred<FindManyResult<ContentItem>>();
		mockFetchContentList.mockImplementation(async (_collection, options) =>
			options?.search ? search.promise : { items: [makeItem()] },
		);

		const screen = await render(
			<ContentPickerModal open onOpenChange={() => {}} collection="posts" onConfirm={() => {}} />,
		);
		await expect.element(screen.getByText("Jane Doe")).toBeVisible();

		await userEvent.type(screen.getByPlaceholder("Search content..."), "zz");
		await vi.waitFor(() =>
			expect(mockFetchContentList).toHaveBeenCalledWith(
				"posts",
				expect.objectContaining({ search: "zz" }),
			),
		);
		await expect.element(screen.getByText("Jane Doe")).toBeVisible();
		expect(screen.getByText("Loading content...").query()).toBeNull();

		search.resolve({ items: [] });
		await expect.element(screen.getByText("No content found")).toBeVisible();
	});

	it("doesn't keep another collection's entries while the chosen collection loads", async () => {
		const pages = deferred<FindManyResult<ContentItem>>();
		mockFetchCollections.mockResolvedValue([
			{ slug: "posts", label: "Posts" },
			{ slug: "pages", label: "Pages" },
		] as Collection[]);
		mockFetchContentList.mockImplementation(async (collection) =>
			collection === "pages" ? pages.promise : { items: [makeItem()] },
		);

		const screen = await render(
			<ContentPickerModal open onOpenChange={() => {}} onConfirm={() => {}} />,
		);
		await expect.element(screen.getByText("Jane Doe")).toBeVisible();

		(screen.getByRole("combobox", { name: "Collection" }).element() as HTMLElement).focus();
		await userEvent.keyboard("{ArrowDown}");
		await expect.element(page.getByRole("option", { name: "Pages" })).toBeVisible();
		(page.getByRole("option", { name: "Pages" }).element() as HTMLElement).click();

		await expect.element(screen.getByText("Loading content...")).toBeInTheDocument();
		expect(screen.getByText("Jane Doe").query()).toBeNull();
		pages.resolve({ items: [] });
		await expect.element(screen.getByText("No content in this collection")).toBeVisible();
	});

	it("doesn't call the collection empty while the collections load", async () => {
		mockFetchCollections.mockReturnValue(new Promise(() => undefined));

		const screen = await render(
			<ContentPickerModal open onOpenChange={() => {}} onConfirm={() => {}} />,
		);

		await expect.element(screen.getByText("Loading content...")).toBeInTheDocument();
		expect(screen.getByText("No content in this collection").query()).toBeNull();
	});
});
