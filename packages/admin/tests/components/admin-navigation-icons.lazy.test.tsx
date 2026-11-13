import { PiggyBank, Plug } from "@phosphor-icons/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { resolveNavIcon } from "../../src/components/admin-navigation-icons";
import { render } from "../utils/render";

const iconSet = vi.hoisted(() => ({ loads: 0 }));

vi.mock("@phosphor-icons/react/ssr", async (importOriginal) => {
	iconSet.loads++;
	return importOriginal();
});

async function renderIcon(name: string) {
	const Icon = resolveNavIcon(name, Plug);
	const screen = await render(
		<React.Suspense fallback={<span>loading</span>}>
			<Icon data-testid="resolved" />
		</React.Suspense>,
	);
	const resolved = screen.getByTestId("resolved");
	await expect.element(resolved).toBeInTheDocument();
	return resolved.element().innerHTML;
}

describe("an icon name outside the built-in map", () => {
	it("renders the fallback without downloading the icon set when Phosphor has no such icon", async () => {
		const { container } = await render(<Plug />);
		expect(await renderIcon("inbox")).toBe(container.querySelector("svg")!.innerHTML);
		expect(iconSet.loads).toBe(0);
	});

	it("still renders a real Phosphor icon", async () => {
		const { container } = await render(<PiggyBank />);
		expect(await renderIcon("piggy-bank")).toBe(container.querySelector("svg")!.innerHTML);
		expect(iconSet.loads).toBe(1);
	});
});
