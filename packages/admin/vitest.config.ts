import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

// Pin a non-UTC timezone so timestamp-parsing tests catch local-vs-UTC bugs.
const contextOptions = { timezoneId: "America/New_York" };
const touchScreenTests = "tests/**/*.touch.test.{ts,tsx}";

export default defineConfig({
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			// As pre-bundle entries beside the root package, the ~1,500 per-icon modules
			// split it into one chunk per icon, which every test file then requests.
			// Each module exports the same components as the root package.
			{ find: /^@phosphor-icons\/react\/dist\/csr\/[^/]+$/, replacement: "@phosphor-icons/react" },
		],
	},
	optimizeDeps: {
		include: [
			"@cloudflare/kumo/primitives/scroll-area",
			"@codemirror/autocomplete",
			"@codemirror/commands",
			"@codemirror/lang-css",
			"@codemirror/lang-html",
			"@codemirror/lang-javascript",
			"@codemirror/language",
			"@codemirror/state",
			"@codemirror/view",
			"@lezer/highlight",
			"react-image-crop",
			"date-fns",
			"react-day-picker/locale/*",
		],
	},
	plugins: [
		{
			name: "media-image-fixtures",
			configureServer(server) {
				const pixel = Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
					"base64",
				);
				const mediaRoute = "/_emdash/api/media/file/";
				// Readable originals whose renditions the image endpoint refuses.
				const readableOriginals = new Set([`${mediaRoute}rendition-refused.png`]);
				// Media whose original and rendition both fail.
				const unreadable = new Set([`${mediaRoute}missing-original.png`]);
				server.middlewares.use((request, response, next) => {
					const url = new URL(request.url ?? "/", "http://localhost");
					if (url.pathname === "/_image") {
						const href = url.searchParams.get("href");
						const source = href ? new URL(href).pathname : "";
						if (!source.startsWith(mediaRoute)) return next();
						if (readableOriginals.has(source) || unreadable.has(source)) {
							response.statusCode = 503;
							response.end();
							return;
						}
					} else if (!readableOriginals.has(url.pathname)) {
						return next();
					}
					response.setHeader("Content-Type", "image/png");
					response.end(pixel);
				});
			},
		},
		{
			name: "load-failure-fixtures",
			configureServer(server) {
				let failNextTableRequest = false;
				server.middlewares.use((request, response, next) => {
					if (request.method === "POST" && request.url === "/__test/fail-nav-icon-table") {
						failNextTableRequest = true;
						response.end();
						return;
					}
					if (request.url?.startsWith("/__test/missing-chunk/")) {
						response.statusCode = 404;
						response.end();
						return;
					}
					if (failNextTableRequest && request.url?.startsWith("/src/lib/nav-icon-loaders.ts")) {
						failNextTableRequest = false;
						response.statusCode = 503;
						response.end();
						return;
					}
					next();
				});
			},
		},
		react({
			babel: {
				plugins: [
					// Match the admin package build so production-fallback tests keep source messages.
					["@lingui/babel-plugin-lingui-macro", { stripMessageField: false }],
				],
			},
		}),
	],
	test: {
		globals: true,
		include: ["tests/**/*.test.{ts,tsx}"],
		setupFiles: ["./tests/setup.ts"],
		browser: {
			enabled: true,
			provider: playwright({ contextOptions }),
			instances: [
				{ browser: "chromium", exclude: [...configDefaults.exclude, touchScreenTests] },
				// Test files run one after another on a shared page, and turning touch
				// emulation off resets its hover and pointer to the machine's own devices,
				// none on Linux CI. Touch-screen tests get pages that start as touch screens.
				{
					browser: "chromium",
					name: "chromium-touch",
					include: [touchScreenTests],
					provider: playwright({ contextOptions: { ...contextOptions, hasTouch: true } }),
				},
			],
			headless: true,
			// Desktop-width viewport: the content editor's settings panel is a
			// slide-in sheet below lg (1024px), which would make its controls
			// unreachable for the tests that exercise them directly.
			viewport: { width: 1280, height: 800 },
		},
	},
});
