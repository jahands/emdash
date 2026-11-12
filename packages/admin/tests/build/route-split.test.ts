/**
 * Reads the built package in `dist/`, so it needs `pnpm build` first.
 */
import { describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import {
	ADMIN_EDITOR_MODULES,
	ADMIN_ROUTE_MODULES,
	type AdminRouteModule,
} from "../../src/route-modules.js";

const EDITOR_PACKAGE =
	/^(?:@tiptap\/|prosemirror-|yjs$|y-protocols|lowlight$|highlight\.js|echarts|zrender)/;
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'();=]*?\bfrom\s*)?["']([^"']+)["']/g;
const DIST = "dist/";

async function readDist(file: string): Promise<string> {
	try {
		return await commands.readFile(`${DIST}${file}`);
	} catch (error) {
		throw new Error(`dist/${file} is missing. Build @emdash-cms/admin before running this test.`, {
			cause: error,
		});
	}
}

/** Packages the built `entry` imports before any dynamic import runs. */
async function staticPackageImports(entry: string): Promise<Set<string>> {
	const packages = new Set<string>();
	const seen = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		const code = (await readDist(file)).replace(/^\/\/# sourceMappingURL=.*$/m, "");
		for (const [, specifier] of code.matchAll(STATIC_IMPORT)) {
			if (!specifier) continue;
			if (specifier.startsWith(".")) {
				pending.push(new URL(specifier, `https://dist/${file}`).pathname.slice(1));
			} else {
				packages.add(specifier);
			}
		}
	}
	return packages;
}

function editorPackages(packages: Set<string>): string[] {
	return [...packages].filter((name) => EDITOR_PACKAGE.test(name));
}

const modules = [...new Set(Object.values(ADMIN_ROUTE_MODULES).flat())] as AdminRouteModule[];

describe("admin build: route splitting", () => {
	it("boots without the editor", async () => {
		expect(editorPackages(await staticPackageImports("app.js"))).toEqual([]);
	});

	it.each(modules.filter((module) => !ADMIN_EDITOR_MODULES.has(module)))(
		"loads %s without the editor",
		async (module) => {
			expect(editorPackages(await staticPackageImports(`${module}.js`))).toEqual([]);
		},
	);

	it.each([...ADMIN_EDITOR_MODULES])("loads the editor with %s", async (module) => {
		expect(editorPackages(await staticPackageImports(`${module}.js`))).toContain("@tiptap/react");
	});
});
