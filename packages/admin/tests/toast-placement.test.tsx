import { Toasty, useKumoToastManager } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../dist/styles.css";
import { render } from "./utils/render.tsx";

function RaiseToast() {
	const toasts = useKumoToastManager();
	const raised = React.useRef(false);
	React.useEffect(() => {
		if (raised.current) return;
		raised.current = true;
		toasts.add({ title: "Scheduled", description: "The entry will be published later" });
	});
	return null;
}

async function restingToast(): Promise<DOMRect> {
	let previous: DOMRect | undefined;
	let box = new DOMRect();
	await vi.waitFor(() => {
		const toast = document.querySelector<HTMLElement>(
			'[role="region"][aria-live] > [role="dialog"]:not([data-starting-style])',
		);
		expect(toast).not.toBeNull();
		[previous, box] = [box, toast!.getBoundingClientRect()];
		expect(box.height).toBeGreaterThan(0);
		expect(box.top).toBe(previous.top);
	});
	return box;
}

describe("toast placement", () => {
	afterEach(async () => {
		await page.viewport(1280, 800);
	});

	it("shows a toast at the top of a phone screen, clear of a sheet's bottom actions", async () => {
		await page.viewport(390, 800);
		await render(
			<Toasty>
				<RaiseToast />
			</Toasty>,
		);

		const toast = await restingToast();
		expect(toast.top).toBeGreaterThanOrEqual(0);
		expect(toast.bottom).toBeLessThan(160);
	});

	it("keeps a toast at the bottom of a wide screen", async () => {
		await page.viewport(1280, 800);
		await render(
			<Toasty>
				<RaiseToast />
			</Toasty>,
		);

		const toast = await restingToast();
		expect(toast.bottom).toBeGreaterThan(700);
		expect(toast.bottom).toBeLessThanOrEqual(800);
	});
});
