import { afterEach, describe, expect, it, vi } from "vitest";

const { adapterGET } = vi.hoisted(() => ({
	adapterGET: vi.fn(async () => new Response("adapter", { status: 418 })),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@astrojs/cloudflare/image-transform-endpoint", () => ({ GET: adapterGET }));
vi.mock(
	"emdash/media/image-endpoint",
	async () => import("../../../core/src/media/image-endpoint.js"),
);

import { GET } from "../../src/image-resizing-endpoint.js";

function call(query: string) {
	const storage = {
		download: vi.fn(async () => ({
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("source"));
					controller.close();
				},
			}),
			contentType: "image/jpeg",
			size: 6,
		})),
	};
	const ctx = {
		request: new Request(`https://site.test/_image?${query}`),
		locals: { emdash: { storage } },
	};
	return { storage, response: GET(ctx as never) };
}

const href = (value: string) => `href=${encodeURIComponent(value)}`;

afterEach(() => {
	vi.clearAllMocks();
});

describe("Cloudflare URL-mode image endpoint", () => {
	it("redirects a media rendition to Cloudflare's transformation of the media route", async () => {
		const { storage, response } = call(
			`${href("https://site.test/_emdash/api/media/file/01PHOTO.jpg")}&w=400&f=webp`,
		);
		const res = await response;

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe(
			"/cdn-cgi/image/width=400,format=webp,quality=85,onerror=redirect/_emdash/api/media/file/01PHOTO.jpg",
		);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
		expect(storage.download).not.toHaveBeenCalled();
	});

	it("caches the redirect for good when the URL is pinned to a version", async () => {
		const res = await call(
			`${href("/_emdash/api/media/file/01PHOTO.jpg?_emdash_media=sha1:ab")}&w=80&f=webp`,
		).response;

		expect(res.headers.get("Location")).toBe(
			"/cdn-cgi/image/width=80,format=webp,quality=85,onerror=redirect/_emdash/api/media/file/01PHOTO.jpg?_emdash_media=sha1%3Aab",
		);
		expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
	});

	it("asks for the largest allowed size for an oversized candidate", async () => {
		const res = await call(`${href("/_emdash/api/media/file/01PHOTO.jpg")}&w=3024&h=4032&f=webp`)
			.response;

		expect(res.headers.get("Location")).toContain("/width=3000,height=4000,");
	});

	it("always transforms the site's own media route, whatever host the href names", async () => {
		const res = await call(
			`${href("https://attacker.test/_emdash/api/media/file/01PHOTO.jpg")}&w=400`,
		).response;

		expect(res.headers.get("Location")).toMatch(
			/^\/cdn-cgi\/image\/[^/]+\/_emdash\/api\/media\/file\/01PHOTO\.jpg$/,
		);
	});

	it("leaves other images to the adapter's endpoint", async () => {
		const res = await call(`${href("https://cdn.test/x.jpg")}&w=400`).response;

		expect(res.status).toBe(418);
		expect(adapterGET).toHaveBeenCalledOnce();
	});

	it("serves the original for a request it can't turn into a transformation", async () => {
		const res = await call(`${href("/_emdash/api/media/file/01PHOTO.jpg")}&w=400&f=gif`).response;

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("source");
	});
});
