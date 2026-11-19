import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { RelationsPanel } from "../../src/components/RelationsPanel.js";
import type { RelationWithUsage } from "../../src/lib/api/relations.js";
import { render } from "../utils/render.js";

const relation: RelationWithUsage = {
	id: "rel-1",
	slug: "posts_authors",
	parentCollection: "posts",
	childCollection: "authors",
	parentLabel: "Posts",
	parentLabelSingular: "Post",
	childLabel: "Authors",
	childLabelSingular: "Author",
	maxChildrenPerParent: 1,
	maxParentsPerChild: null,
	boundFields: [],
	linkCount: 3,
};

function panel(props: { isLoading?: boolean; relations?: RelationWithUsage[] }) {
	return (
		<div style={{ width: 720 }}>
			<RelationsPanel
				collectionSlug="posts"
				relations={props.relations ?? []}
				collections={[]}
				isLoading={props.isLoading}
				onCreateRelation={vi.fn()}
				onUpdateRelation={vi.fn()}
				onDeleteRelation={vi.fn()}
			/>
		</div>
	);
}

describe("RelationsPanel while relations load", () => {
	it("holds the header and rows in place instead of showing the empty state", async () => {
		const screen = await render(panel({ isLoading: true }));

		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading relations...");
		expect(screen.getByText("No relations yet").query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "New Relation" })).toBeDisabled();
		const heading = screen.getByRole("heading", { name: "Relations" }).element();
		const header = heading.parentElement!.parentElement!;
		const headerHeight = header.getBoundingClientRect().height;
		const firstRow = () => header.nextElementSibling!.firstElementChild!;
		const rowHeight = firstRow().getBoundingClientRect().height;

		await screen.rerender(panel({ relations: [relation] }));
		await expect.element(screen.getByText("posts_authors")).toBeVisible();

		expect(screen.getByRole("status").query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "New Relation" })).toBeEnabled();
		expect(header.getBoundingClientRect().height).toBe(headerHeight);
		expect(Math.abs(firstRow().getBoundingClientRect().height - rowHeight)).toBeLessThanOrEqual(1);
	});
});
