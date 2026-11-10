import { i18n } from "@lingui/core";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import {
	ContentSettingsPanel,
	type ContentSettingsPanelProps,
} from "../../src/components/ContentSettingsPanel";
import type { ContentItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/components/RevisionHistory", () => ({
	RevisionHistory: () => <div>Revision History</div>,
}));

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => <div>Taxonomy</div>,
	useHasApplicableTaxonomies: () => false,
}));

vi.mock("../../src/components/editor/DocumentOutline", () => ({
	DocumentOutline: () => <div>Outline</div>,
}));

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		useNavigate: () => vi.fn(),
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })) };
});

const publishedItem: ContentItem = {
	id: "item-1",
	type: "posts",
	slug: "my-post",
	status: "published",
	data: { title: "My Post" },
	authorId: null,
	createdAt: "2026-01-15T10:30:00Z",
	updatedAt: "2026-01-15T10:30:00Z",
	publishedAt: "2026-01-15T10:30:00Z",
	scheduledAt: null,
	liveRevisionId: "rev-live",
	draftRevisionId: "rev-live",
};

function panel(
	hasPendingChanges: boolean,
	dir: "ltr" | "rtl",
	overrides: Partial<ContentSettingsPanelProps> = {},
): React.ReactElement {
	const props: ContentSettingsPanelProps = {
		collection: "posts",
		item: hasPendingChanges ? { ...publishedItem, draftRevisionId: "rev-draft" } : publishedItem,
		isNew: false,
		slug: "my-post",
		onSlugChange: vi.fn(),
		status: "published",
		supportsDrafts: true,
		isLive: true,
		hasPendingChanges,
		supportsRevisions: true,
		// A published entry can be scheduled once it has draft changes.
		canSchedule: hasPendingChanges,
		onOpenSchedule: vi.fn(),
		onDiscardDraft: vi.fn(),
		onDelete: vi.fn(),
		currentUser: { id: "u1", role: 40 },
		users: [],
		onAuthorChange: vi.fn(),
		activeBylines: [],
		availableBylines: [],
		availableBylinesLoaded: true,
		onBylinesChange: vi.fn(),
		hasSeo: false,
		onSeoChange: vi.fn(),
		portableTextEditor: {} as Editor,
		blockSidebarPanel: null,
		onBlockSidebarClose: vi.fn(),
		onBlockSidebarDelete: vi.fn(),
		...overrides,
	};
	return (
		<div dir={dir} style={{ width: 368 }}>
			<ContentSettingsPanel {...props} />
		</div>
	);
}

describe("ContentSettingsPanel publish section", () => {
	it.each(["ltr", "rtl"] as const)(
		"keeps the sections below in place when a published entry gains draft changes in %s",
		async (dir) => {
			if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
			await page.viewport(1280, 900);
			const screen = await render(panel(false, dir));
			const slug = screen.getByRole("textbox", { name: "Slug" });
			await expect.element(slug).toBeVisible();
			const before = slug.element().getBoundingClientRect().top;

			await screen.rerender(panel(true, dir));
			await expect.element(screen.getByText("Draft changes", { exact: true })).toBeVisible();
			await expect
				.element(screen.getByRole("button", { name: "Discard changes", exact: true }))
				.toBeEnabled();
			await expect
				.element(screen.getByRole("button", { name: "Schedule", exact: true }))
				.toBeEnabled();
			expect(slug.element().getBoundingClientRect().top).toBe(before);
		},
	);

	it("offers discarding and scheduling once a published entry has draft changes", async () => {
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		const screen = await render(panel(false, "ltr"));
		await expect.element(screen.getByText("No draft changes", { exact: true })).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Discard changes", exact: true }))
			.toBeDisabled();
		await expect
			.element(screen.getByRole("button", { name: "Schedule", exact: true }))
			.toBeDisabled();
	});

	it("keeps the sections below Ownership in place when the users arrive", async () => {
		if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
		await page.viewport(1280, 900);
		const admin = { id: "u1", role: 50 };
		const users = [{ id: "u1", name: "Ada Admin", email: "ada@example.com", role: 50 }] as never;
		const loading = { currentUser: admin, users: undefined, usersLoading: true };
		const loaded = { currentUser: admin, users, usersLoading: false };
		const item = { ...publishedItem, authorId: "u1" };
		const screen = await render(panel(false, "ltr", { ...loading, item }));
		const bylines = screen.getByRole("heading", { name: "Bylines" });
		await expect.element(bylines).toBeVisible();
		const before = bylines.element().getBoundingClientRect().top;

		await screen.rerender(panel(false, "ltr", { ...loaded, item }));
		await expect.element(screen.getByText("ada@example.com")).toBeVisible();
		expect(bylines.element().getBoundingClientRect().top).toBe(before);
	});
});
