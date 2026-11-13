import { ADMIN_PREFETCH_MODULES, adminRouteModules } from "@emdash-cms/admin/route-modules";

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
	return [...preloadedHrefs(preloads, pathname)];
}

/**
 * For each module the admin downloads before its screen opens, the files it
 * needs beyond those the admin page at `pathname` preloads.
 */
export function adminPrefetchFiles(json: string, pathname: string): Record<string, string[]> {
	const preloads = parseAdminPreloads(json);
	if (!preloads) return {};
	const preloaded = preloadedHrefs(preloads, pathname);
	const files: Record<string, string[]> = {};
	for (const module of ADMIN_PREFETCH_MODULES) {
		const hrefs = (preloads.routes[module] ?? []).filter((href) => !preloaded.has(href));
		if (hrefs.length > 0) files[module] = hrefs;
	}
	return files;
}

function preloadedHrefs(preloads: AdminPreloads, pathname: string): Set<string> {
	const index = pathname.indexOf(ADMIN_BASE);
	const routePath = index === -1 ? "/" : pathname.slice(index + ADMIN_BASE.length) || "/";
	const hrefs = new Set(preloads.boot);
	for (const module of adminRouteModules(routePath)) {
		for (const href of preloads.routes[module] ?? []) hrefs.add(href);
	}
	return hrefs;
}
