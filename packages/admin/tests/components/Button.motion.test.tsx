import { Button as KumoButton } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";

import "../../dist/styles.css";
import { AdminBootError } from "../../src/components/AdminBootError.js";
import { Button, loadingButtonProps } from "../../src/components/Button.js";
import { PublishingScheduleDialog } from "../../src/components/PublishingDateTimeEditor.js";
import { render } from "../utils/render.js";

afterEach(async () => {
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

async function reduceMotion() {
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
}

function expectStillAndSilent(button: HTMLElement) {
	expect(button.querySelector("svg")).not.toBeNull();
	expect(button.getAnimations({ subtree: true })).toHaveLength(0);
	expect(button.querySelector("animate, animateTransform, animateMotion, set")).toBeNull();
	expect(button.querySelector('[role="status"]')).toBeNull();
	expect(button).toBeDisabled();
	expect(button).toHaveAttribute("aria-busy", "true");
}

describe("loading buttons", () => {
	it("spin only while motion is allowed", async () => {
		const screen = await render(<Button loading>Save</Button>);
		const button = screen.getByRole("button", { name: "Save" }).element() as HTMLElement;

		expect(button.getAnimations({ subtree: true }).length).toBeGreaterThan(0);
		await reduceMotion();
		expectStillAndSilent(button);
	});

	it("hold still under reduced motion in a Kumo Button call site", async () => {
		await reduceMotion();
		const screen = await render(
			<AdminBootError
				labels={{ title: "Failed to load", retry: "Retry" }}
				retrying
				onRetry={() => {}}
			/>,
		);

		expectStillAndSilent(screen.getByRole("button", { name: "Retry" }).element() as HTMLElement);
	});

	it("hold still under reduced motion in a LayerDialog.Action call site", async () => {
		await reduceMotion();
		const screen = await render(
			<PublishingScheduleDialog
				open
				entryKey="post-1:en"
				isLive={false}
				isPending
				onOpenChange={() => {}}
			/>,
		);
		const dialog = screen.getByRole("dialog", { name: "Schedule publication" });
		await expect.element(dialog).toBeVisible();

		expectStillAndSilent(
			dialog.getByRole("button", { name: "Schedule", exact: true }).element() as HTMLElement,
		);
	});

	it.each(["ltr", "rtl"] as const)(
		"keep their size and name when they start and stop loading in %s",
		async (dir) => {
			const cases: React.ComponentProps<typeof KumoButton>[] = [
				{ children: "Save" },
				{ children: "Save", variant: "primary" },
				{ children: "Save", size: "sm" },
				{ children: "Save", size: "lg", variant: "destructive" },
				{ children: "Add", icon: <Plus />, size: "sm" },
				{ children: "Add", icon: <Plus />, size: "lg", variant: "outline" },
				{ children: "Add", icon: Plus, variant: "primary" },
				{ "aria-label": "Add", icon: <Plus /> },
				{ "aria-label": "Add", icon: <Plus />, shape: "square", size: "xs" },
				{ "aria-label": "Add", icon: <Plus />, shape: "circle", variant: "primary" },
			];
			const { icon, size, children, ...dialogProps } = cases[6]!;
			const screen = await render(
				<div dir={dir} className="flex flex-col items-start gap-2">
					{cases.map((props, index) => (
						<div key={index} className="flex gap-2">
							<Button {...props} data-testid={`idle-${index}`} />
							<Button {...props} loading data-testid={`loading-${index}`} />
						</div>
					))}
					<div className="flex gap-2">
						<KumoButton
							{...dialogProps}
							{...loadingButtonProps(false, { icon, size, children })}
							data-testid="idle-dialog"
						/>
						<KumoButton
							{...dialogProps}
							{...loadingButtonProps(true, { icon, size, children })}
							data-testid="loading-dialog"
						/>
					</div>
				</div>,
			);

			for (const key of [...cases.keys(), "dialog"]) {
				const idle = screen.getByTestId(`idle-${key}`).element() as HTMLElement;
				const loading = screen.getByTestId(`loading-${key}`).element() as HTMLElement;
				const idleBox = idle.getBoundingClientRect();
				const loadingBox = loading.getBoundingClientRect();
				expect([loadingBox.width, loadingBox.height], `case ${key}`).toEqual([
					idleBox.width,
					idleBox.height,
				]);
				expect(loading).toHaveAccessibleName(idle.textContent || idle.getAttribute("aria-label")!);
				const spinner = loading
					.querySelector('[aria-hidden="true"] > svg')!
					.getBoundingClientRect();
				expect(spinner.left).toBeGreaterThanOrEqual(loadingBox.left);
				expect(spinner.right).toBeLessThanOrEqual(loadingBox.right);
			}
		},
	);
});
