import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { expect, it, vi } from "vitest";

const siteSettings = vi.hoisted(() => {
	let release!: (settings: unknown) => void;
	const read = new Promise((resolve) => {
		release = resolve;
	});
	return { read, release };
});

vi.mock("../../src/settings/index.js", () => ({
	getSiteSettingsWithDb: () => siteSettings.read,
}));

const { default: AdminPage } = await import("../../src/astro/routes/admin.astro");

const fakeReactRenderer = {
	name: "@astrojs/react",
	check: () => false,
	renderToStaticMarkup: () => ({ html: "" }),
};

it("sends the head's preloads before reading the site icon", async () => {
	const container = await AstroContainer.create({ streaming: true });
	container.addServerRenderer({ name: "@astrojs/react", renderer: fakeReactRenderer });
	container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
	const response = await container.renderToResponse(AdminPage, {
		locals: { emdash: { db: {}, storage: null, config: {} } },
		request: new Request("http://localhost/_emdash/admin"),
	});
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();

	let sent = "";
	while (!sent.includes('<link rel="modulepreload" href="/_astro/PluginRegistry.js">')) {
		const { value, done } = await reader.read();
		if (done) throw new Error("The page ended before its preloads");
		sent += decoder.decode(value);
	}
	expect(sent).not.toContain('rel="icon"');

	siteSettings.release({
		favicon: { url: "/_emdash/api/media/file/icon", contentType: "image/svg+xml" },
	});
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		sent += decoder.decode(value);
	}
	expect(sent).toContain(
		'<link rel="icon" href="/_emdash/api/media/file/icon" type="image/svg+xml">',
	);
	expect(sent.indexOf('rel="icon"')).toBeLessThan(sent.indexOf("</head>"));
});
