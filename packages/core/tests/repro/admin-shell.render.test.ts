import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import AdminPage from "../../src/astro/routes/admin.astro";

const fakeReactRenderer = {
	name: "@astrojs/react",
	check: () => false,
	renderToStaticMarkup: () => ({ html: "" }),
};

const signedIn = { user: { id: "user_01", email: "ada@example.com", role: 50 } };

async function renderAdmin(acceptLanguage: string, path = "/_emdash/admin", locals: object = {}) {
	const container = await AstroContainer.create();
	container.addServerRenderer({ name: "@astrojs/react", renderer: fakeReactRenderer });
	container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
	return container.renderToString(AdminPage, {
		locals,
		request: new Request(`http://localhost${path}`, {
			headers: { "accept-language": acceptLanguage },
		}),
	});
}

describe("admin shell", () => {
	it.each([
		["en", "ltr", "/_astro/messages.en.mjs"],
		["ar", "rtl", "/_astro/messages.ar.mjs"],
	])("preloads the %s catalog instead of inlining it", async (locale, dir, catalogUrl) => {
		const html = await renderAdmin(locale);

		expect(html).toContain(`<html lang="${locale}" dir="${dir}"`);
		expect(html).toContain(`<link rel="modulepreload" href="${catalogUrl}">`);
		expect(html).toContain(`&quot;messagesUrl&quot;:[0,&quot;${catalogUrl}&quot;]`);
		expect(new TextEncoder().encode(html).length).toBeLessThan(30 * 1024);
	});

	function bootLoader(html: string) {
		const loader = html.match(/<div id="emdash-boot-loader"[^>]*>([\s\S]*?)<\/div>\s*<script/)?.[1];
		expect(loader).toBeDefined();
		return loader!;
	}

	it.each([
		["en", "Loading"],
		["ar", "جارٍ التحميل"],
	])(
		"shows a signed-in %s user the admin's frame, announced once in that language",
		async (locale, label) => {
			const loader = bootLoader(
				await renderAdmin(locale, "/_emdash/admin/content/posts", signedIn),
			);

			expect(loader).toContain('class="emdash-frame"');
			expect(loader).toContain('class="emdash-frame-sidebar"');
			expect(loader.match(/role="status"/g)).toHaveLength(1);
			expect(
				loader
					.split(/<[^>]*>/)
					.join("")
					.trim(),
			).toBe(label);
		},
	);

	it.each([
		["a signed-out visitor", "/_emdash/admin", {}],
		["a signed-in user on the sign-in screen", "/_emdash/admin/login", signedIn],
		["a signed-in user authorizing a device", "/_emdash/admin/device/", signedIn],
	])(
		"shows %s a sign-in card in outline instead of the frame, announced once",
		async (_who, path, locals) => {
			const loader = bootLoader(await renderAdmin("en", path, locals));

			expect(loader).not.toContain("emdash-frame");
			expect(loader).toContain('class="emdash-standalone-card"');
			expect(loader.match(/role="status"/g)).toHaveLength(1);
			expect(
				loader
					.split(/<[^>]*>/)
					.join("")
					.trim(),
			).toBe("Loading");
		},
	);

	it.each([
		["en", "Failed to load admin", "Try again"],
		["ar", "فشل تحميل لوحة الإدارة", "حاول مجددًا"],
	])("gives the admin the %s text to show if it fails to load", async (locale, title, retry) => {
		const html = await renderAdmin(locale);

		expect(html).toContain(
			`&quot;bootErrorLabels&quot;:[0,{&quot;title&quot;:[0,&quot;${title}&quot;],&quot;retry&quot;:[0,&quot;${retry}&quot;]}]`,
		);
	});

	it("preloads the requested screen's modules with the admin's", async () => {
		const editor = await renderAdmin("en", "/_emdash/admin/content/posts/01ABC");
		expect(editor).toContain('<link rel="modulepreload" href="/_astro/PluginRegistry.js">');
		expect(editor).toContain('<link rel="modulepreload" href="/_astro/ContentEditor.js">');
		expect(editor).not.toContain('<link rel="modulepreload" href="/_astro/Settings.js">');

		const settings = await renderAdmin("en", "/_emdash/admin/settings");
		expect(settings).toContain('<link rel="modulepreload" href="/_astro/Settings.js">');
		expect(settings).not.toContain('<link rel="modulepreload" href="/_astro/ContentEditor.js">');
	});
});
