import { Button as KumoButton } from "@cloudflare/kumo";
import { Plus } from "@phosphor-icons/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";

import "../../dist/styles.css";
import { AdminBootError } from "../../src/components/AdminBootError.js";
import { Button } from "../../src/components/Button.js";
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

	it("keep the size and look of Kumo's loading state", async () => {
		const cases: React.ComponentProps<typeof KumoButton>[] = [
			{ children: "Save" },
			{ children: "Save", variant: "primary" },
			{ children: "Add", icon: <Plus />, size: "sm" },
			{ children: "Add", icon: <Plus />, size: "lg", variant: "outline" },
			{ "aria-label": "Add", icon: <Plus />, shape: "square", size: "xs" },
		];
		const screen = await render(
			<div className="flex flex-col items-start gap-2">
				{cases.map((props, index) => (
					<div key={index} className="flex gap-2">
						<KumoButton {...props} loading data-testid={`kumo-${index}`} />
						<Button {...props} loading data-testid={`admin-${index}`} />
					</div>
				))}
			</div>,
		);

		for (const [index] of cases.entries()) {
			const kumo = screen.getByTestId(`kumo-${index}`).element() as HTMLElement;
			const admin = screen.getByTestId(`admin-${index}`).element() as HTMLElement;
			const kumoBox = kumo.getBoundingClientRect();
			const adminBox = admin.getBoundingClientRect();
			expect(adminBox.width).toBe(kumoBox.width);
			expect(adminBox.height).toBe(kumoBox.height);
			expect(getComputedStyle(admin).opacity).toBe(getComputedStyle(kumo).opacity);
			expect(admin.querySelector("svg")!.getBoundingClientRect().width).toBe(
				kumo.querySelector("svg")!.getBoundingClientRect().width,
			);
		}
	});
});
