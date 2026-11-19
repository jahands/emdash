import { i18n } from "@lingui/core";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { ContentList } from "../../src/components/ContentList.js";
import type { ContentItem } from "../../src/lib/api";
import { LiveSyncProvider } from "../../src/lib/realtime/LiveSyncProvider.js";
import { loadMessages } from "../../src/locales/loadMessages";
import { FakeSocket, openHub, ticketResponse } from "../utils/fake-hub.js";
import { render } from "../utils/render.js";
import { createTestQueryClient } from "../utils/test-helpers.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			params: _params,
			search: _search,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			params?: Record<string, string>;
			search?: Record<string, unknown>;
		}) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
	};
});

const posts: ContentItem[] = ["01A", "01B", "01C"].map((id) => ({
	id,
	type: "posts",
	slug: id.toLowerCase(),
	status: "draft",
	data: { title: `A post with a title long enough to wrap on a phone ${id}` },
	authorId: "me",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-02T00:00:00Z",
	publishedAt: null,
	scheduledAt: null,
	liveRevisionId: null,
	draftRevisionId: null,
}));

beforeEach(() => {
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith("/_emdash/api/realtime") && init?.method === "POST") return ticketResponse();
		return new Response(null, { status: 404 });
	});
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	i18n.loadAndActivate({ locale: "en", messages: {} });
	await page.viewport(1280, 800);
});

/** Every cell's box, and every row link's, so any change in the table's layout shows. */
function boxes(): string[] {
	return Array.from(document.querySelectorAll("tbody td, tbody a"), (element) => {
		const { left, top, width, height } = element.getBoundingClientRect();
		return [left, top, width, height].map((value) => value.toFixed(1)).join(",");
	});
}

describe("Content list presence layout", () => {
	it.each([
		{ name: "desktop in English", width: 1280, locale: "en", dir: "ltr" },
		{ name: "phone in Arabic", width: 390, locale: "ar", dir: "rtl" },
	] as const)("moves nothing when a face appears, on $name", async ({ width, locale, dir }) => {
		await page.viewport(width, 800);
		if (locale === "ar") i18n.loadAndActivate({ locale, messages: await loadMessages(locale) });
		const queryClient = createTestQueryClient();
		await render(
			<QueryClientProvider client={queryClient}>
				<LiveSyncProvider enabled>
					<main dir={dir} lang={locale} style={{ padding: 16 }}>
						<ContentList collection="posts" collectionLabel="Posts" items={posts} />
					</main>
				</LiveSyncProvider>
			</QueryClientProvider>,
		);
		const socket = await openHub(["content/posts"]);
		const before = boxes();

		socket.presence(
			[
				{
					topic: "content/posts/01B",
					people: [
						{ userId: "ana", name: "أنا", clientId: "tab-ana", activity: "editing" },
						{ userId: "ben", name: "Ben", clientId: "tab-ben", activity: "editing" },
					],
				},
			],
			true,
		);
		const face = await vi.waitFor(() => {
			const found = document.querySelector<HTMLElement>("[data-presence-slot] [role=img]");
			expect(found).not.toBeNull();
			return found!;
		});
		expect(face.textContent).toBe("2");

		expect(boxes()).toEqual(before);
		const cell = face.closest("td")!.getBoundingClientRect();
		const bounds = face.getBoundingClientRect();
		expect(bounds.left).toBeGreaterThanOrEqual(cell.left);
		expect(bounds.right).toBeLessThanOrEqual(cell.right);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
	});
});
