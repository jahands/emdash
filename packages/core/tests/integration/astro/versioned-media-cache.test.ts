import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { handleMediaGet, handleMediaReplaceMetadata } from "../../../src/api/handlers/media.js";
import { GET as imageGET } from "../../../src/astro/image-endpoint.js";
import { PUT as putReplace } from "../../../src/astro/routes/api/media/[id]/replace.js";
import { GET as fileGET } from "../../../src/astro/routes/api/media/file/[...key].js";
import {
	IMMUTABLE_IMAGE_CACHE,
	MAX_VERIFIED_MEDIA_BYTES,
	MUTABLE_MEDIA_CACHE_CONTROL,
} from "../../../src/media/image-endpoint.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { EmDashStorageError, type Storage } from "../../../src/storage/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const KEY = "01PHOTO.png";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const SAME_SIZE_REPLACEMENT = new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1]);

/**
 * Object-store semantics shared by R2 and S3: an upload replaces the whole
 * object at once, and a download reports the size and upload time stored with
 * the object.
 */
function objectStorage(): Storage {
	const objects = new Map<string, { bytes: Uint8Array; contentType: string; uploaded: Date }>();
	const storage = {
		async upload(options: { key: string; body: Uint8Array; contentType: string }) {
			objects.set(options.key, {
				bytes: new Uint8Array(options.body),
				contentType: options.contentType,
				uploaded: new Date(),
			});
			return { key: options.key, url: `/media/${options.key}`, size: options.body.byteLength };
		},
		async download(key: string) {
			const object = objects.get(key);
			if (!object) throw new EmDashStorageError(`Object not found: ${key}`, "NOT_FOUND");
			return {
				body: new Blob([object.bytes]).stream(),
				contentType: object.contentType,
				size: object.bytes.byteLength,
				lastModified: object.uploaded,
			};
		},
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the routes under test use only upload and download
	return storage as unknown as Storage;
}

const storageKinds = [
	{
		name: "local",
		create: async () => {
			const directory = await mkdtemp(join(tmpdir(), "emdash-versioned-media-"));
			return {
				storage: new LocalStorage({ directory, baseUrl: "/media" }) as Storage,
				cleanup: () => rm(directory, { recursive: true, force: true }),
			};
		},
	},
	{
		name: "object store (R2/S3)",
		create: async () => ({ storage: objectStorage(), cleanup: async () => {} }),
	},
];

const sha1 = (bytes: Uint8Array) => computeContentHash(bytes);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describeEachDialect("version-pinned media caching", (dialect) => {
	describe.each(storageKinds)("on $name storage", (kind) => {
		let ctx: DialectTestContext;
		let storage: Storage;
		let cleanup: () => Promise<void>;
		let hash: string;

		beforeEach(async () => {
			ctx = await setupForDialect(dialect);
			({ storage, cleanup } = await kind.create());
			await storage.upload({ key: KEY, body: BYTES, contentType: "image/png" });
			hash = await sha1(BYTES);
			await ctx.db
				.insertInto("media")
				.values({
					id: "media_photo",
					filename: "photo.png",
					mime_type: "image/png",
					size: BYTES.length,
					width: 1,
					height: 1,
					storage_key: KEY,
					content_hash: hash,
					status: "ready",
					author_id: "admin",
				})
				.execute();
			transform.mockReset();
			transform.mockImplementation(async (data: Uint8Array) => ({ data, format: "webp" }));
		});

		afterEach(async () => {
			await cleanup();
			await teardownForDialect(ctx);
		});

		const pin = (version: string) => `_emdash_media=${encodeURIComponent(version)}`;

		function fileRequest(query: string, headers?: Record<string, string>) {
			const request = new Request(`http://localhost/_emdash/api/media/file/${KEY}${query}`, {
				headers,
			});
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- route test supplies the Astro fields GET reads
			return fileGET({ params: { key: KEY }, locals: { emdash: { storage } }, request } as never);
		}

		function renditionRequest(version: string | null, headers?: Record<string, string>) {
			const href = `/_emdash/api/media/file/${KEY}${version ? `?${pin(version)}` : ""}`;
			const request = new Request(
				`http://localhost/_image?href=${encodeURIComponent(href)}&w=100&f=webp`,
				{ headers },
			);
			return imageGET({
				request,
				url: new URL(request.url),
				locals: { emdash: { storage } },
			} as never);
		}

		/** Every response for `version`: the original and a rendition. */
		async function pinnedResponses(version: string) {
			const responses = [await fileRequest(`?${pin(version)}`), await renditionRequest(version)];
			return Promise.all(
				responses.map(async (response) => ({
					status: response.status,
					cacheControl: response.headers.get("Cache-Control"),
					bytes: new Uint8Array(await response.arrayBuffer()),
				})),
			);
		}

		it("serves the original and renditions pinned to the stored file as immutable", async () => {
			for (const response of await pinnedResponses(hash)) {
				expect(response.status).toBe(200);
				expect(response.cacheControl).toBe(IMMUTABLE_IMAGE_CACHE);
				expect(response.bytes).toEqual(BYTES);
			}
		});

		it("keeps unversioned and stale-version URLs revalidating", async () => {
			expect((await fileRequest("")).headers.get("Cache-Control")).toBe(
				MUTABLE_MEDIA_CACHE_CONTROL,
			);
			expect((await renditionRequest(null)).headers.get("Cache-Control")).toBe(
				MUTABLE_MEDIA_CACHE_CONTROL,
			);
			for (const response of await pinnedResponses("sha1:deadbeef")) {
				expect(response.cacheControl).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
			}
		});

		it("revalidates a pinned URL's 304, which is sent without reading the bytes", async () => {
			const original = await fileRequest(`?${pin(hash)}`);
			const rendition = await renditionRequest(hash);

			const revalidatedOriginal = await fileRequest(`?${pin(hash)}`, {
				"If-None-Match": original.headers.get("ETag")!,
			});
			const revalidatedRendition = await renditionRequest(hash, {
				"If-None-Match": rendition.headers.get("ETag")!,
			});

			for (const response of [revalidatedOriginal, revalidatedRendition]) {
				expect(response.status).toBe(304);
				expect(response.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
			}
			expect(revalidatedRendition.headers.get("ETag")).toBe(rendition.headers.get("ETag"));
			expect(revalidatedRendition.headers.get("Content-Type")).toBeNull();
			expect(transform).toHaveBeenCalledOnce();
		});

		it("never serves immutable bytes that don't match the pinned version while a same-size replacement is in progress", async () => {
			const newHash = await sha1(SAME_SIZE_REPLACEMENT);
			const stored = deferred();
			const resume = deferred();
			const pausingStorage = {
				...storage,
				download: storage.download.bind(storage),
				upload: async (options: Parameters<Storage["upload"]>[0]) => {
					const result = await storage.upload(options);
					stored.resolve();
					await resume.promise;
					return result;
				},
			};
			const form = new FormData();
			form.set("file", new File([SAME_SIZE_REPLACEMENT], "photo.png", { type: "image/png" }));
			form.set("width", "1");
			form.set("height", "1");
			const replacing = putReplace({
				params: { id: "media_photo" },
				request: new Request("http://localhost/_emdash/api/media/media_photo/replace", {
					method: "PUT",
					body: form,
				}),
				locals: {
					emdash: {
						db: ctx.db,
						config: {},
						storage: pausingStorage,
						handleMediaGet: (id: string) => handleMediaGet(ctx.db, id),
						handleMediaReplaceMetadata: (
							id: string,
							key: string,
							input: Parameters<typeof handleMediaReplaceMetadata>[3],
						) => handleMediaReplaceMetadata(ctx.db, id, key, input),
					},
					user: { id: "admin", role: 50, email: "admin@example.com", name: "Admin" },
				},
			} as never) as Promise<Response>;

			await stored.promise;
			const row = await ctx.db
				.selectFrom("media")
				.select("content_hash")
				.where("id", "=", "media_photo")
				.executeTakeFirstOrThrow();
			expect(row.content_hash).toBe(hash);

			const duringOld = await pinnedResponses(hash);
			const duringNew = await pinnedResponses(newHash);
			for (const response of [...duringOld, ...duringNew]) {
				expect(response.bytes).toEqual(SAME_SIZE_REPLACEMENT);
			}
			for (const response of duringOld) {
				expect(response.cacheControl).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
			}
			for (const response of duringNew) {
				expect(response.cacheControl).toBe(IMMUTABLE_IMAGE_CACHE);
			}

			resume.resolve();
			expect((await replacing).status).toBe(200);

			for (const response of await pinnedResponses(hash)) {
				expect(response.cacheControl).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
			}
			for (const response of await pinnedResponses(newHash)) {
				expect(response.cacheControl).toBe(IMMUTABLE_IMAGE_CACHE);
				expect(response.bytes).toEqual(SAME_SIZE_REPLACEMENT);
			}
		});

		it("streams a pinned original too large to verify, revalidating", async () => {
			const large = new Uint8Array(MAX_VERIFIED_MEDIA_BYTES + 1).fill(7);
			await storage.upload({ key: KEY, body: large, contentType: "image/png" });

			const response = await fileRequest(`?${pin(await sha1(large))}`);

			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
			expect((await response.arrayBuffer()).byteLength).toBe(large.length);
		});
	});
});
