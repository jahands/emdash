import { adminRouteModules } from "@emdash-cms/admin/route-modules";

/** The admin's JavaScript, as the client build laid it out. */
export interface AdminPreloads {
	/** Files the admin loads before it renders any route. */
	boot: string[];
	/** For each admin route module, the files it adds to `boot`. */
	routes: Record<string, string[]>;
}

const ADMIN_BASE = "/_emdash/admin";

function parseAdminPreloads(json: string): AdminPreloads | undefined {
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { boot, routes } = parsed as Partial<AdminPreloads>;
		if (!Array.isArray(boot) || typeof routes !== "object" || routes === null) return undefined;
		return { boot, routes };
	} catch {
		return undefined;
	}
}

/**
 * The files the admin page at `pathname` should preload: the admin's boot
 * files and the modules of the route the URL opens. Empty when the build
 * recorded nothing, as in dev.
 */
export function adminPreloadHrefs(json: string, pathname: string): string[] {
	const preloads = parseAdminPreloads(json);
	if (!preloads) return [];
	const index = pathname.indexOf(ADMIN_BASE);
	const routePath = index === -1 ? "/" : pathname.slice(index + ADMIN_BASE.length) || "/";
	const hrefs = new Set(preloads.boot);
	for (const module of adminRouteModules(routePath)) {
		for (const href of preloads.routes[module] ?? []) hrefs.add(href);
	}
	return [...hrefs];
}
