import { Acorn } from "@phosphor-icons/react";
import * as React from "react";
import { expect, it } from "vitest";

import { resolveNavIcon } from "../../src/components/admin-navigation-icons";
import { NavIcon } from "../../src/components/Sidebar";
import { render } from "../utils/render.tsx";

class ShellBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed ? <p>Shell failed</p> : this.props.children;
	}
}

function Fallback({ className }: { className?: string }) {
	return <span className={className}>Fallback icon</span>;
}

function PluginNavIcon({ name }: { name: string }) {
	return <NavIcon icon={resolveNavIcon(name, Fallback)} isActive={false} />;
}

it("shows the fallback when the icon table fails to load, and loads the icon on a later render", async () => {
	await fetch("/__test/fail-nav-icon-table", { method: "POST" });

	const screen = await render(
		<ShellBoundary>
			<PluginNavIcon name="acorn" />
		</ShellBoundary>,
	);

	await expect.element(screen.getByText("Fallback icon")).toBeInTheDocument();
	expect(screen.getByText("Shell failed").query()).toBeNull();

	await screen.rerender(
		<ShellBoundary>
			<PluginNavIcon name="acorn" />
		</ShellBoundary>,
	);

	const acorn = await render(<Acorn aria-hidden="true" />);
	const acornGlyph = acorn.container.querySelector("svg")!.innerHTML;
	await expect.poll(() => screen.container.querySelector("svg")?.innerHTML).toBe(acornGlyph);
	expect(screen.getByText("Fallback icon").query()).toBeNull();
});
