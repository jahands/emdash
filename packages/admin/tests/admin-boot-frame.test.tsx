import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../dist/styles.css";
import { AdminFrameSkeleton } from "../src/components/AdminFrameSkeleton";
import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest } from "../src/lib/api";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "admin-boot-frame",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

function json(data: unknown) {
	return Promise.resolve(
		new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }),
	);
}

function requestUrl(input: string | URL | Request) {
	return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

let manifestHeld: Promise<void> = Promise.resolve();
let manifestFails = false;

function renderAdmin() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 60_000 } },
	});
	const router = createAdminRouter(queryClient);
	void router.navigate({ to: "/" });
	return render(
		<ThemeProvider defaultTheme="light">
			<I18nProvider i18n={i18n}>
				<Toasty>
					<QueryClientProvider client={queryClient}>
						<RouterProvider router={router} />
					</QueryClientProvider>
				</Toasty>
			</I18nProvider>
		</ThemeProvider>,
	);
}

function box(element: Element | null) {
	expect(element).not.toBeNull();
	const { x, width, height } = element!.getBoundingClientRect();
	return { x: Math.round(x), width: Math.round(width), height: Math.round(height) };
}

function borderBottom(element: Element) {
	const style = getComputedStyle(element);
	return `${style.borderBottomWidth} ${style.borderBottomStyle} ${style.borderBottomColor}`;
}

function shownBackground(element: Element | null): string {
	if (!element) return "";
	const background = getComputedStyle(element).backgroundColor;
	return background === "rgba(0, 0, 0, 0)" ? shownBackground(element.parentElement) : background;
}

/** Where the sidebar, the header and the page area sit. */
function frameLayout(parts: {
	sidebar: Element | null;
	header: Element;
	main: Element;
	theme: Element;
	account: Element;
}) {
	const sidebar = parts.sidebar && box(parts.sidebar);
	const theme = box(parts.theme);
	return {
		sidebar: sidebar && sidebar.width > 0 ? { x: sidebar.x, width: sidebar.width } : null,
		header: { ...box(parts.header), border: borderBottom(parts.header) },
		main: { x: box(parts.main).x, background: shownBackground(parts.main) },
		theme: { width: theme.width, height: theme.height },
		accountEnd: Math.round(parts.account.getBoundingClientRect()[endSide()]),
	};
}

function endSide() {
	return document.documentElement.dir === "rtl" ? "left" : "right";
}

describe("the admin's loading frame", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		localStorage.clear();
		manifestHeld = Promise.resolve();
		manifestFails = false;
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = requestUrl(input);
			if (url === "/_emdash/api/manifest") {
				await manifestHeld;
				if (manifestFails) {
					return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Down" } }), {
						status: 500,
						headers: { "Content-Type": "application/json" },
					});
				}
				return json({ data: manifest });
			}
			if (url === "/_emdash/api/auth/me") {
				return json({ data: { id: "ada", email: "ada@example.com", name: "Ada", role: 50 } });
			}
			if (url === "/_emdash/api/dashboard") {
				return json({ data: { collections: [], mediaCount: 0, userCount: 0, recentItems: [] } });
			}
			if (url === "/_emdash/api/admin/comments/counts") {
				return json({ data: { pending: 0, approved: 0, spam: 0, trash: 0 } });
			}
			if (url.startsWith("/_emdash/api/menus")) return json({ data: [] });
			if (url.startsWith("/_emdash/api/admin/transfer")) {
				return json({
					data: { portableDomain: { empty: false, blockers: [], seededScaffold: [] } },
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		}) as typeof fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		document.getElementById("emdash-boot-loader")?.remove();
		document.documentElement.dir = "ltr";
		i18n.loadAndActivate({ locale: "en", messages: {} });
		await page.viewport(1280, 800);
	});

	it.each([
		["en", "ltr", 1280],
		["ar", "rtl", 1280],
		["en", "ltr", 390],
	] as const)(
		"lays out the sidebar, header and page area where the %s admin shows them at %s, %ipx wide",
		async (locale, dir, width) => {
			await page.viewport(width, 800);
			i18n.loadAndActivate({ locale, messages: {} });
			document.documentElement.dir = dir;

			const admin = await renderAdmin();
			await expect.element(admin.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
			const shown = frameLayout({
				sidebar: admin.container.querySelector("aside"),
				header: admin.container.querySelector("header")!,
				main: admin.container.querySelector("main")!,
				theme: admin.getByRole("button", { name: /^Switch to / }).element(),
				account: admin.getByRole("button", { name: "Ada", exact: true }).element(),
			});
			await admin.unmount();

			const skeleton = await render(<AdminFrameSkeleton />);
			const loading = frameLayout({
				sidebar: skeleton.container.querySelector(".emdash-frame-sidebar"),
				header: skeleton.container.querySelector(".emdash-frame-header")!,
				main: skeleton.container.querySelector(".emdash-frame-main")!,
				theme: skeleton.container.querySelector(".emdash-frame-theme")!,
				account: skeleton.container.querySelector(".emdash-frame-user")!,
			});

			expect(loading).toEqual(shown);
		},
	);

	it("keeps the page's boot loader until the admin's frame is on screen, which goes on announcing the loading once", async () => {
		const bootLoader = document.createElement("div");
		bootLoader.id = "emdash-boot-loader";
		bootLoader.innerHTML = '<div class="emdash-frame"><span role="status">Loading</span></div>';
		document.body.prepend(bootLoader);
		let releaseManifest = () => {};
		manifestHeld = new Promise((resolve) => {
			releaseManifest = resolve;
		});
		const container = document.createElement("div");
		document.body.append(container);

		let frameAtRemoval: boolean | undefined;
		const observer = new MutationObserver(() => {
			if (frameAtRemoval === undefined && !bootLoader.isConnected) {
				frameAtRemoval = container.querySelector(".emdash-frame") !== null;
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
		const previousUrl = location.href;
		history.replaceState(null, "", "/_emdash/admin/");

		try {
			const { AdminApp } = await import("../src/App");
			const screen = await render(<AdminApp />, { container });
			await expect.poll(() => frameAtRemoval).toBe(true);
			const statuses = document.querySelectorAll("[role=status]");
			expect(statuses).toHaveLength(1);
			expect(container.contains(statuses[0]!)).toBe(true);
			expect(statuses[0]!.textContent).toBe("Loading");

			releaseManifest();
			await expect.element(screen.getByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
			expect(document.querySelectorAll(".emdash-frame")).toHaveLength(0);
		} finally {
			observer.disconnect();
			container.remove();
			history.replaceState(null, "", previousUrl);
		}
	});

	it("shows a failed load in the frame's page area, where the admin would have been", async () => {
		manifestFails = true;
		const admin = await renderAdmin();

		const retry = admin.getByRole("button", { name: "Retry" });
		await expect.element(retry).toBeVisible();
		const main = admin.container.querySelector(".emdash-frame-main")!;
		expect(main.contains(retry.element())).toBe(true);
		expect(admin.container.querySelector(".emdash-frame-sidebar")).not.toBeNull();
		expect(admin.getByRole("status").query()).toBeNull();
	});
});
