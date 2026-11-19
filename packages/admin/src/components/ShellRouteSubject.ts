import { useLocation } from "@tanstack/react-router";

import { getSidebarTaxonomies } from "./Sidebar";

interface SubjectManifest {
	collections: Record<string, { label: string }>;
	taxonomies: Parameters<typeof getSidebarTaxonomies>[0];
	i18n?: { defaultLocale: string };
}

/** The label of the collection or taxonomy a route's params name, as the sidebar shows it. */
export function useRouteSubjectLabel(
	manifest: SubjectManifest | undefined,
	params: Record<string, string | undefined>,
): string | undefined {
	const routeLocale = useLocation({
		select: (location) =>
			new URL(location.href, "http://emdash.local").searchParams.get("locale") ?? undefined,
	});
	if (!manifest) return undefined;
	if (params.collection) return manifest.collections[params.collection]?.label;
	if (params.taxonomy) {
		return getSidebarTaxonomies(
			manifest.taxonomies,
			routeLocale,
			manifest.i18n?.defaultLocale,
		).find((taxonomy) => taxonomy.name === params.taxonomy)?.label;
	}
	return undefined;
}
