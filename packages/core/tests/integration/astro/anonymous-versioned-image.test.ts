import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { CONFIG, DIALECT, MOCK_RUNTIME, mockCreateRuntime } = vi.hoisted(() => ({
	CONFIG: {
		database: { entrypoint: "", config: {} as Record<string, unknown> },
		auth: { mode: "none" },
		storage: {
			entrypoint: "emdash/storage/local",
			config: { directory: "", baseUrl: "/_emdash/api/media/file" },
		},
		imageEndpointRoute: "/_image",
	},
	DIALECT: { name: "sqlite" as "sqlite" | "postgres" },
	MOCK_RUNTIME: new Proxy(
		{},
		{
			get: (target, key) => (key === "then" ? undefined : () => undefined),
		},
	),
	mockCreateRuntime: vi.fn(),
}));

vi.mock("virtual:emdash/config", () => ({ default: CONFIG }));
// Mirrors generateDialectModule() for an adapter without request scoping,
// which is every Node adapter.
vi.mock("virtual:emdash/dialect", async () => {
	const real =
		DIALECT.name === "postgres"
			? await import("../../../src/db/postgres.js")
			: await import("../../../src/db/sqlite.js");
	return {
		createDialect: real.createDialect,
		dialectType: DIALECT.name,
		createRequestScopedDb: () => null,
		createCoalescingDialect: undefined,
		executeCollectionDeletionGuard: undefined,
	};
});
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }));
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }));
vi.mock("virtual:emdash/sandbox-runner", () => ({
	createSandboxRunner: null,
	sandboxBypassed: false,
	sandboxEnabled: false,
}));
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }));
vi.mock("virtual:emdash/storage", async () => {
	const { createStorage } = await import("../../../src/storage/local.js");
	return { createStorage };
});
vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));

vi.mock("../../../src/emdash-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/emdash-runtime.js")>();
	return {
		DB_INIT_DEADLINE_MS: actual.DB_INIT_DEADLINE_MS,
		EmDashRuntime: {
			create: mockCreateRuntime,
			isDatabaseUnmigrated: () => false,
			getStorage: actual.EmDashRuntime.getStorage,
		},
	};
});

vi.mock("../../../src/loader.js", () => ({ getDb: vi.fn() }));

vi.mock("astro:assets", () => ({
	getConfiguredImageService: async () => ({
		parseURL: (url: URL) => ({ width: Number(url.searchParams.get("w")) }),
		transform: async (data: Uint8Array) => ({ data, format: "webp" }),
	}),
	imageConfig: {},
}));
vi.mock("astro/assets/endpoint/generic", () => ({
	GET: () => new Response("generic endpoint", { status: 418 }),
}));

import {
	IMMUTABLE_IMAGE_CACHE,
	MUTABLE_MEDIA_CACHE_CONTROL,
} from "../../../src/media/image-endpoint.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { computeContentHash } from "../../../src/utils/hash.js";

const MEDIA_KEY = "01ANONYMOUSPINNED.png";
const MEDIA_BYTES = new TextEncoder().encode("pinned image bytes");

const dialects: Array<{ name: "sqlite" | "postgres"; database: typeof CONFIG.database }> = [
	{ name: "sqlite", database: { entrypoint: "emdash/db/sqlite", config: { url: ":memory:" } } },
];
if (process.env.EMDASH_TEST_PG) {
	dialects.push({
		name: "postgres",
		database: {
			entrypoint: "emdash/db/postgres",
			config: { connectionString: process.env.EMDASH_TEST_PG },
		},
	});
}

let mediaDir: string;
let hash: string;

beforeAll(async () => {
	mediaDir = await mkdtemp(join(tmpdir(), "emdash-anonymous-pinned-"));
	CONFIG.storage.config.directory = mediaDir;
	const storage = new LocalStorage({ directory: mediaDir, baseUrl: "/_emdash/api/media/file" });
	await storage.upload({ key: MEDIA_KEY, body: MEDIA_BYTES, contentType: "image/png" });
	hash = await computeContentHash(MEDIA_BYTES);
});

afterAll(async () => {
	await rm(mediaDir, { recursive: true, force: true });
});

describe.each(dialects)("anonymous version-pinned image request on Node $name", (dialect) => {
	let onRequest: typeof import("../../../src/astro/middleware.js").default;
	let authOnRequest: typeof import("../../../src/astro/middleware/auth.js").onRequest;
	let imageGET: typeof import("../../../src/astro/image-endpoint.js").GET;
	let getDb: typeof import("../../../src/loader.js").getDb;

	beforeAll(async () => {
		DIALECT.name = dialect.name;
		CONFIG.database = dialect.database;
		vi.resetModules();
		onRequest = (await import("../../../src/astro/middleware.js")).default;
		authOnRequest = (await import("../../../src/astro/middleware/auth.js")).onRequest;
		imageGET = (await import("../../../src/astro/image-endpoint.js")).GET;
		getDb = (await import("../../../src/loader.js")).getDb;
	});

	beforeEach(() => {
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:setup-verified")];
		delete (globalThis as Record<symbol, unknown>)[Symbol.for("emdash:runtime-holder")];
		mockCreateRuntime.mockReset().mockResolvedValue(MOCK_RUNTIME);
		vi.mocked(getDb).mockClear();
	});

	async function anonymousImageRequest(version: string): Promise<Response> {
		const href = `/_emdash/api/media/file/${MEDIA_KEY}?_emdash_media=${encodeURIComponent(version)}`;
		const url = new URL(`https://example.com/_image?href=${encodeURIComponent(href)}&w=320&f=webp`);
		const locals: Record<string, unknown> = {};
		const context = {
			request: new Request(url),
			url,
			routePattern: "/_image",
			cookies: { get: () => undefined, set: vi.fn() },
			locals,
			redirect: vi.fn(),
			isPrerendered: false,
			session: { get: vi.fn() },
		};
		return onRequest(context as never, () =>
			authOnRequest(context as never, () => imageGET(context as never) as Promise<Response>),
		) as Promise<Response>;
	}

	it("serves a rendition pinned to the stored file as immutable without touching the database", async () => {
		const response = await anonymousImageRequest(hash);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe(IMMUTABLE_IMAGE_CACHE);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(MEDIA_BYTES);
		expect(getDb).not.toHaveBeenCalled();
		expect(mockCreateRuntime).not.toHaveBeenCalled();
	});

	it("serves a rendition pinned to another version as revalidating", async () => {
		const response = await anonymousImageRequest("sha1:0000000000000000000000000000000000000000");

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe(MUTABLE_MEDIA_CACHE_CONTROL);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(MEDIA_BYTES);
	});
});
