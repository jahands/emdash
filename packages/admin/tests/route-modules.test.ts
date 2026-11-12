import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { RouteModulePreload } from "../src/lib/route-module.js";
import { ROUTE_MODULE_LOADERS } from "../src/route-module-loaders.js";
import {
	ADMIN_ROUTE_MODULES,
	adminRouteModules,
	type AdminRouteModule,
} from "../src/route-modules.js";
import { createAdminRouter } from "../src/router.js";

const sources = import.meta.glob("../src/**/*.tsx");

function samplePath(fullPath: string): string {
	return fullPath
		.split("/")
		.map((segment) => (segment === "$" ? "a/b" : segment.startsWith("$") ? "x" : segment))
		.join("/");
}

const router = createAdminRouter(new QueryClient());
const routes = Object.values(router.routesById).filter(
	(route) => !route.isRoot && route.options.path !== undefined,
);

describe("admin route modules", () => {
	it.each(routes.map((route) => [route.fullPath, route] as const))(
		"%s preloads the modules the admin page preloads for it",
		(_path, route) => {
			const component = route.options.component as Partial<RouteModulePreload> | undefined;
			const preloaded = [...(component?.modules ?? [])].toSorted();
			expect([...adminRouteModules(samplePath(route.fullPath))].toSorted()).toEqual(preloaded);
			if (preloaded.length > 0) expect(component?.preload).toBeTypeOf("function");
		},
	);

	it("lists exactly the routes the router has", () => {
		expect(Object.keys(ADMIN_ROUTE_MODULES).toSorted()).toEqual(
			[...new Set(routes.map((route) => route.fullPath))].toSorted(),
		);
	});

	it.each(Object.keys(ROUTE_MODULE_LOADERS) as AdminRouteModule[])(
		"loads %s from its own source file",
		async (module) => {
			const source = sources[`../src/${module}.tsx`];
			expect(source).toBeDefined();
			expect(await ROUTE_MODULE_LOADERS[module]()).toBe(await source?.());
		},
	);

	it("matches static segments before parameters and splats", () => {
		expect(adminRouteModules("/content/posts/new")).toEqual(["components/ContentEditor"]);
		expect(adminRouteModules("/content/posts")).toEqual(["components/ContentList"]);
		expect(adminRouteModules("/content-types/relations")).toEqual(["components/RelationList"]);
		expect(adminRouteModules("/plugins/registry/did/slug")).toEqual([
			"components/RegistryPluginDetail",
		]);
		expect(adminRouteModules("/plugins/forms/submissions/1")).toEqual([
			"components/SandboxedPluginPage",
		]);
		expect(adminRouteModules("/plugins/forms")).toEqual([]);
		expect(adminRouteModules("/")).toEqual(["components/Dashboard"]);
		expect(adminRouteModules("/settings/general/")).toEqual([
			"components/settings/GeneralSettings",
		]);
		expect(adminRouteModules("/no/such/screen")).toEqual([]);
	});
});
