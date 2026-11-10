import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { AdminBrandingProvider } from "../../src/lib/admin-branding-context";
import { measureLayoutShifts } from "../utils/layout-stability";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return { ...actual, useSearch: () => ({ token: "valid-invite-token" }) };
});

const validateInvite = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, validateInviteToken: () => validateInvite() };
});

Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

const { InviteAcceptPage } = await import("../../src/components/InviteAcceptPage");

describe("invite page loading", () => {
	it.each([
		["desktop", 1280, 800],
		["phone", 390, 844],
	])("keeps the heading and card in place at %s width", async (_label, width, height) => {
		await page.viewport(width, height);
		let resolveInvite!: (value: unknown) => void;
		validateInvite.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveInvite = resolve;
				}),
		);
		const screen = await render(
			<AdminBrandingProvider adminBranding={{}}>
				<InviteAcceptPage />
			</AdminBrandingProvider>,
		);
		const heading = screen.getByRole("heading", { name: "Accept Invite" });
		await expect.element(heading).toBeInTheDocument();
		const before = heading.element().getBoundingClientRect();

		const shifts = await measureLayoutShifts(async () => {
			resolveInvite({ email: "invitee@example.com", role: 30, roleName: "Author" });
			await expect.element(screen.getByLabelText("Your name (optional)")).toHaveFocus();
		});
		const total = shifts.reduce((sum, shift) => sum + shift.value, 0);
		expect(total).toBeLessThan(0.001);
		const after = heading.element().getBoundingClientRect();
		expect(after.top).toBeCloseTo(before.top, 0);
		await page.viewport(1280, 800);
	});
});
