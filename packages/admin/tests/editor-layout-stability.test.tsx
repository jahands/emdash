import { Toasty } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { I18nProvider } from "@lingui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../dist/styles.css";

import { ThemeProvider } from "../src/components/ThemeProvider";
import type { AdminManifest, ContentItem } from "../src/lib/api";
import { loadMessages } from "../src/locales/loadMessages";
import { LocaleDirectionProvider } from "../src/locales/LocaleDirectionProvider.js";
import { createAdminRouter } from "../src/router";
import { render } from "./utils/render.tsx";
import { createTestQueryClient } from "./utils/test-helpers.tsx";

const MANIFEST: AdminManifest = {
	version: "1.0.0",
	hash: "layout-stability",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "preview"],
			hasSeo: false,
			fields: {
				title: { kind: "string", label: "Title" },
				summary: { kind: "text", label: "Summary" },
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: undefined,
};

const ITEM: ContentItem & { _rev: string } = {
	id: "post-1",
	type: "posts",
	slug: "post-1",
	status: "published",
	locale: "en",
	translationGroup: null,
	data: { title: "Initial title", summary: "Summary" },
	authorId: "user-1",
	primaryBylineId: null,
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	publishedAt: "2026-01-01T00:00:00Z",
	scheduledAt: null,
	liveRevisionId: "revision-live",
	draftRevisionId: "revision-live",
	_rev: "rev-1",
};

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

type PutReply = "ok" | "error" | "conflict";

function createMockServer({
	replies = [],
	usersReady,
}: { replies?: { reply: PutReply; wait?: Promise<void> }[]; usersReady?: Promise<void> } = {}) {
	const originalFetch = globalThis.fetch;
	let putIndex = 0;
	let current = { ...ITEM };
	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init?.method ?? "GET").toUpperCase();
		if (method === "GET" && url === "/_emdash/api/manifest")
			return jsonResponse({ data: MANIFEST });
		if (method === "GET" && url === "/_emdash/api/auth/me")
			return jsonResponse({ data: { id: "user-1", role: 40 } });
		if (method === "GET" && url.startsWith("/_emdash/api/bylines"))
			return jsonResponse({ data: { items: [] } });
		if (method === "GET" && url.startsWith("/_emdash/api/admin/users")) {
			await usersReady;
			return jsonResponse({
				data: {
					items: [
						{ id: "user-1", name: "First author", email: "first@example.com" },
						{ id: "user-2", name: "Second author", email: "second@example.com" },
					],
				},
			});
		}
		if (method === "GET" && url.startsWith("/_emdash/api/revisions/")) {
			const id = url.split("/revisions/")[1]!.split("?")[0]!;
			return jsonResponse({
				data: {
					item: {
						id,
						collection: "posts",
						entryId: "post-1",
						data: current.data,
						authorId: null,
						createdAt: "2026-01-01T00:00:00Z",
					},
				},
			});
		}
		if (method === "GET" && url.includes("/revisions"))
			return jsonResponse({ data: { items: [], total: 0 } });
		if (method === "GET" && url.startsWith("/_emdash/api/content/posts/post-1")) {
			const { _rev, ...item } = current;
			return jsonResponse({ data: { item, _rev } });
		}
		if (method === "PUT" && url.startsWith("/_emdash/api/content/posts/post-1")) {
			if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
			const payload = JSON.parse(init.body) as { data?: Record<string, unknown> };
			const next = replies[putIndex++] ?? { reply: "ok" };
			await next.wait;
			if (next.reply === "error")
				return jsonResponse(
					{ error: { code: "VALIDATION_ERROR", message: "Title is rejected by the server." } },
					500,
				);
			if (next.reply === "conflict") {
				current = { ...current, _rev: `rev-${putIndex + 1}` };
				return jsonResponse(
					{ error: { code: "CONFLICT", message: "The entry changed since you opened it." } },
					409,
				);
			}
			current = {
				...current,
				data: { ...current.data, ...payload.data },
				draftRevisionId: `revision-draft-${putIndex}`,
				_rev: `rev-${putIndex + 1}`,
			};
			const { _rev, ...item } = current;
			return jsonResponse({ data: { item, _rev } });
		}
		throw new Error(`Unhandled request: ${method} ${url}`);
	}) as typeof fetch;
	return { restore: () => (globalThis.fetch = originalFetch) };
}

async function renderEditPage(locale: string) {
	i18n.loadAndActivate({ locale, messages: locale === "en" ? {} : await loadMessages(locale) });
	const queryClient = createTestQueryClient();
	const router = createAdminRouter(queryClient);
	await router.navigate({
		to: "/content/$collection/$id",
		params: { collection: "posts", id: "post-1" },
	});
	const screen = await render(
		<I18nProvider i18n={i18n}>
			<LocaleDirectionProvider>
				<ThemeProvider defaultTheme="light">
					<Toasty>
						<QueryClientProvider client={queryClient}>
							<RouterProvider router={router} />
						</QueryClientProvider>
					</Toasty>
				</ThemeProvider>
			</LocaleDirectionProvider>
		</I18nProvider>,
	);
	const titleBox = page.getByRole("textbox", { name: "Title", exact: true });
	await expect.element(titleBox).toHaveValue("Initial title");
	const title = () => titleBox.element() as HTMLInputElement;
	return { screen, title };
}

/** Every element on screen the writer works with, by a stable name, except the Save control. */
function anchors() {
	const bar = document.querySelector<HTMLElement>("[data-emdash-editor-bar]")!;
	const found = new Map<string, DOMRect>();
	const add = (name: string, element: Element) => {
		const rect = element.getBoundingClientRect();
		const onScreen =
			rect.width > 0 &&
			rect.right > 0 &&
			rect.bottom > 0 &&
			rect.left < window.innerWidth &&
			rect.top < window.innerHeight;
		if (onScreen) found.set(name, rect);
	};
	bar.querySelectorAll<HTMLElement>("button, a").forEach((element, index) => {
		if (!element.querySelector("[data-save-button-labels]")) add(`bar:${index}`, element);
	});
	document.querySelectorAll("form input, form textarea").forEach((element, index) => {
		add(`field:${index}`, element);
	});
	document.querySelectorAll<HTMLElement>("[data-settings-section]").forEach((element) => {
		add(`section:${element.dataset.settingsSection}`, element);
	});
	return found;
}

/** Names the anchors that moved more than 2 px between two samples. */
function moved(before: Map<string, DOMRect>, after: Map<string, DOMRect>) {
	const shifts: string[] = [];
	for (const [name, rect] of before) {
		const next = after.get(name);
		if (!next) {
			shifts.push(`${name} disappeared`);
			continue;
		}
		const dx = Math.abs(next.left - rect.left);
		const dy = Math.abs(next.top - rect.top);
		if (dx > 2 || dy > 2) shifts.push(`${name} moved ${Math.round(dx)}x${Math.round(dy)}`);
	}
	return shifts;
}

/**
 * What a screen reader is told that says `text`: each live region, and each
 * toast inside the notifications region, counted at its innermost element.
 */
function announcementsOf(text: string) {
	const live = [
		...document.querySelectorAll<HTMLElement>(
			'[role="alert"], [role="status"], [aria-live]:not([aria-live="off"]), [aria-live] [role="dialog"]:not([data-ending-style])',
		),
	].filter((element) => element.textContent?.includes(text));
	return live.filter(
		(element) => !live.some((other) => other !== element && element.contains(other)),
	);
}

const VIEWPORTS = [
	{ name: "desktop", width: 1280, locale: "en" },
	{ name: "phone", width: 390, locale: "en" },
	{ name: "Arabic desktop", width: 1280, locale: "ar" },
	{ name: "Arabic phone", width: 390, locale: "ar" },
] as const;

let server: ReturnType<typeof createMockServer> | undefined;

afterEach(async () => {
	await page.viewport(1280, 800);
	server?.restore();
	server = undefined;
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("ContentEditor layout stability", () => {
	it.each(VIEWPORTS)(
		"keeps the bar and fields in place while editing and saving ($name)",
		async ({ width, locale }) => {
			await page.viewport(width, 800);
			const save = deferred();
			server = createMockServer({ replies: [{ reply: "ok", wait: save.promise }] });
			const { title } = await renderEditPage(locale);
			const clean = anchors();

			title().focus();
			await page.elementLocator(title()).fill("Edited title");
			const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
			await expect.poll(() => submit.disabled).toBe(false);
			expect(moved(clean, anchors())).toEqual([]);

			submit.click();
			await expect.poll(() => submit.getAttribute("aria-busy")).toBe("true");
			expect(moved(clean, anchors())).toEqual([]);

			save.resolve();
			await expect.poll(() => submit.getAttribute("aria-busy")).toBe("false");
			await expect.poll(() => moved(clean, anchors())).toEqual([]);
		},
	);

	it.each(VIEWPORTS)(
		"keeps the bar and fields in place and announces a failed save once ($name)",
		async ({ width, locale }) => {
			await page.viewport(width, 800);
			server = createMockServer({ replies: [{ reply: "error" }] });
			const { title } = await renderEditPage(locale);
			const clean = anchors();

			await page.elementLocator(title()).fill("Rejected title");
			const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
			await expect.poll(() => submit.disabled).toBe(false);
			const dirty = anchors();
			submit.click();

			await expect
				.poll(() => announcementsOf("Title is rejected by the server.").length)
				.toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(announcementsOf("Title is rejected by the server.")).toHaveLength(1);
			expect(moved(clean, dirty)).toEqual([]);
			expect(moved(dirty, anchors())).toEqual([]);
			expect(title().value).toBe("Rejected title");
		},
	);

	it.each(VIEWPORTS)(
		"keeps the bar and fields in place when a save conflicts ($name)",
		async ({ width, locale }) => {
			await page.viewport(width, 800);
			server = createMockServer({ replies: [{ reply: "conflict" }, { reply: "ok" }] });
			const { title, screen } = await renderEditPage(locale);

			await page.elementLocator(title()).fill("Conflicting title");
			const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
			await expect.poll(() => submit.disabled).toBe(false);
			const dirty = anchors();
			submit.click();

			const conflict = i18n._(msg`This entry changed somewhere else after you opened it.`);
			await expect.poll(() => announcementsOf(conflict).length).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(announcementsOf(conflict)).toHaveLength(1);
			expect(moved(dirty, anchors())).toEqual([]);
			expect(title().value).toBe("Conflicting title");

			await screen.getByRole("button", { name: i18n._(msg`Save anyway`) }).click();
			await expect.poll(() => announcementsOf(conflict)).toHaveLength(0);
			expect(moved(dirty, anchors())).toEqual([]);
		},
	);

	it("keeps later settings sections in place while the user list loads", async () => {
		const users = deferred();
		server = createMockServer({ usersReady: users.promise });
		await renderEditPage("en");
		const bylines = () => document.querySelector('[data-settings-section="bylines"]');
		await expect.poll(() => bylines()).not.toBeNull();
		const loading = anchors();

		users.resolve();
		await expect
			.poll(() => document.querySelector('[data-settings-section="ownership"]')?.textContent)
			.toContain("first@example.com");
		expect(moved(loading, anchors())).toEqual([]);
	});
});
