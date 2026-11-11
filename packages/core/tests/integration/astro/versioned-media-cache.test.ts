import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transform = vi.fn();

vi.mock("astro:assets", () => ({
	getConfiguredImageService: vi.fn(() =>
		Promise.resolve({
			transform,
			parseURL: vi.fn((url: URL) => ({
				width: Number(url.searchParams.get("w")),
				format: url.searchParams.get("f") ?? undefined,
			})),
		}),
	),
	imageConfig: {},
}));

vi.mock("astro/assets/endpoint/generic", () => ({
	GET: vi.fn(() => Promise.resolve(new Response("generic", { status: 200 }))),
}));

import { GET as imageGET } from "../../../src/astro/image-endpoint.js";
import { GET as fileGET } from "../../../src/astro/routes/api/media/file/[...key].js";
import {
	IMMUTABLE_IMAGE_CACHE,
	lookupMediaVersion,
	MUTABLE_MEDIA_CACHE_CONTROL,
} from "../../../src/media/image-endpoint.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const KEY = "01PHOTO.jpg";
const BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const REPLACEMENT = new Uint8Array([6, 7, 8, 9, 10, 11]);

describeEachDialect("version-pinned media caching", (dialect) => {
	let ctx: DialectTestContext;
	let directory: string;
	let storage: LocalStorage;
	let hash: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		directory = await mkdtemp(join(tmpdir(), "emdash-versioned-media-"));
		storage = new LocalStorage({ directory, baseUrl: "/media" });
		await storage.upload({ key: KEY, body: BYTES, contentType: "image/jpeg" });
		hash = await computeContentHash(BYTES);
		await ctx.db
			.insertInto("media")
			.values({
				id: "media_photo",
				filename: "photo.jpg",
				mime_type: "image/jpeg",
				size: BYTES.length,
				storage_key: KEY,
				content_hash: hash,
				status: "ready",
			})
			.execute();
		transform.mockReset();
		transform.mockResolvedValue({ data: new Uint8Array([42]), format: "webp" });
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
		await teardownForDialect(ctx);
	});

	const locals = () => ({ emdash: { storage, db: ctx.db } });

	function fileRequest(query: string, headers?: Record<string, string>) {
		const request = new Request(`http://localhost/_emdash/api/media/file/${KEY}${query}`, {
			headers,
		});
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- route test supplies the Astro fields GET reads
		return fileGET({ params: { key: KEY }, locals: locals(), request } as never);
	}

	function imageRequest(href: string, query: string, headers?: Record<string, string>) {
		const request = new Request(
			`http://localhost/_image?href=${encodeURIComponent(href)}&${query}`,
			{ headers },
		);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- endpoint test supplies the Astro fields GET reads
		return imageGET({ request, url: new URL(request.url), locals: locals() } as never);
	}

	it("reads the stored version by storage key", async () => {
		expect(await lookupMediaVersion(ctx.db, KEY)).toEqual({
			contentHash: hash,
			size: BYTES.length,
		});
		expect(await lookupMediaVersion(ctx.db, "missing.jpg")).toBeUndefined();
	});

	it("serves a file URL pinned to the current version as immutable", async () => {
		const pinned = `?_emdash_media=${encodeURIComponent(hash)}`;
		const response = await fileRequest(pinned);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE_IMAGE_CACHE);

		const revalidated = await fileRequest(pinned, {
			"If-None-Match": response.headers.get("ETag")!,
		});
		expect(revalidated.status).toBe(304);
		expect(revalidated.headers.get("Cache-Control")).toBe(IMMUTABLE_IMAGE_CACHE);
	});

	it("keeps unversioned and stale-version file URLs revalidating", async () => {
		expect((await fileRequest("")).headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
		expect((await fileRequest("?_emdash_media=sha1%3Adeadbeef")).headers.get("Cache-Control")).toBe(
			MUTABLE_MEDIA_CACHE_CONTROL,
		);
	});

	it("revalidates while storage holds a replacement the row doesn't describe yet", async () => {
		await storage.upload({ key: KEY, body: REPLACEMENT, contentType: "image/jpeg" });
		const response = await fileRequest(`?_emdash_media=${encodeURIComponent(hash)}`);
		expect(response.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
	});

	it("serves a version-pinned rendition as immutable, unversioned ones revalidating", async () => {
		const pinnedHref = `/_emdash/api/media/file/${KEY}?_emdash_media=${encodeURIComponent(hash)}`;
		const pinned = await imageRequest(pinnedHref, "w=100&f=webp");
		expect(pinned.status).toBe(200);
		expect(pinned.headers.get("Cache-Control")).toBe(IMMUTABLE_IMAGE_CACHE);

		const unversioned = await imageRequest(`/_emdash/api/media/file/${KEY}`, "w=100&f=webp");
		expect(unversioned.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
	});

	it("answers a rendition's revalidation with the 200's metadata", async () => {
		const href = `/_emdash/api/media/file/${KEY}?_emdash_media=${encodeURIComponent(hash)}`;
		const first = await imageRequest(href, "w=100&f=webp");
		expect(first.headers.get("Content-Type")).toBe("image/webp");

		const revalidated = await imageRequest(href, "w=100&f=webp", {
			"If-None-Match": first.headers.get("ETag")!,
		});

		expect(revalidated.status).toBe(304);
		expect(transform).toHaveBeenCalledOnce();
		for (const name of ["Content-Type", "Cache-Control", "ETag", "Last-Modified"]) {
			const value = revalidated.headers.get(name);
			if (value !== null) expect(value).toBe(first.headers.get(name));
		}
		expect(revalidated.headers.get("Content-Type")).not.toBe("image/jpeg");
	});
});
