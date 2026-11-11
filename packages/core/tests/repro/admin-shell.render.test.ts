import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import AdminPage from "../../src/astro/routes/admin.astro";

const fakeReactRenderer = {
	name: "@astrojs/react",
	check: () => false,
	renderToStaticMarkup: () => ({ html: "" }),
};

async function renderAdmin(acceptLanguage: string) {
	const container = await AstroContainer.create();
	container.addServerRenderer({ name: "@astrojs/react", renderer: fakeReactRenderer });
	container.addClientRenderer({ name: "@astrojs/react", entrypoint: "@astrojs/react/client.js" });
	return container.renderToString(AdminPage, {
		locals: {},
		request: new Request("http://localhost/_emdash/admin", {
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
});
