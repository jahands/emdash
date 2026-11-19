import type { Plugin } from "vite";

const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

const MEDIA_FILE_PREFIX = "/_emdash/api/media/file/";
const FILE_EXTENSION = /\.[a-z0-9]+$/i;

/**
 * Serves the media files and `/_image` renditions admin previews request, as a
 * site does, so a preview that loads stays loaded instead of turning broken
 * moments later. Every file is a 1×1 PNG, except that a storage key with no
 * file extension or starting with `missing/` fails to load along with its
 * renditions, and one starting with `no-renditions/` loads but its renditions
 * fail.
 */
export function testMediaServer(): Plugin {
	return {
		name: "emdash-test-media-server",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				const url = new URL(request.url ?? "/", "http://localhost");
				const rendition = url.pathname === "/_image";
				if (!rendition && !url.pathname.startsWith(MEDIA_FILE_PREFIX)) {
					next();
					return;
				}
				const file = rendition
					? new URL(url.searchParams.get("href") ?? "/", "http://localhost").pathname
					: url.pathname;
				const key = file.startsWith(MEDIA_FILE_PREFIX)
					? file.slice(MEDIA_FILE_PREFIX.length)
					: null;
				if (
					key === null ||
					!FILE_EXTENSION.test(key) ||
					key.startsWith("missing/") ||
					(rendition && key.startsWith("no-renditions/"))
				) {
					response.statusCode = 404;
					response.end();
					return;
				}
				response.setHeader("Content-Type", "image/png");
				response.end(PIXEL_PNG);
			});
		},
	};
}
