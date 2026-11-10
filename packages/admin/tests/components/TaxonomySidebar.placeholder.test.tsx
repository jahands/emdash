import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useHasApplicableTaxonomies } from "../../src/components/TaxonomySidebar";
import type { AdminManifest } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

const TAXONOMIES = [
	{ id: "tax-1", name: "tag", label: "Tags", hierarchical: false, collections: ["posts"] },
];

function Probe({ collection }: { collection: string }) {
	return <span>{useHasApplicableTaxonomies(collection) ? "has taxonomies" : "no taxonomies"}</span>;
}

describe("useHasApplicableTaxonomies", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("answers from the manifest while the taxonomy definitions are still loading", async () => {
		vi.stubGlobal("fetch", () => new Promise(() => {}));
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		client.setQueryData<Pick<AdminManifest, "taxonomies">>(["manifest"], {
			taxonomies: TAXONOMIES,
		});

		const screen = await render(
			<QueryClientProvider client={client}>
				<Probe collection="posts" />
			</QueryClientProvider>,
		);
		await expect.element(screen.getByText("has taxonomies")).toBeInTheDocument();
	});
});
