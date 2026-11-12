import * as React from "react";

import type { AdminManifest } from "./api.js";
import { resolveContentListColumns } from "./content-list-columns.js";
import { usePluginAdmins } from "./plugin-context.js";

const SYSTEM_DATE_FIELDS = new Set(["publishedAt", "createdAt", "updatedAt"]);

/**
 * The entry fields the content list renders, so the list can request only
 * those instead of whole entries: the title fields `getEntryTitle` reads, a
 * custom date field, and the configured list columns.
 *
 * `undefined` (whole entries) when a plugin contributes a column to the
 * collection, because plugin cells receive the whole entry. Columns are
 * matched regardless of role so the request doesn't change once the
 * current user loads.
 */
export function useContentListFields(
	collection: string,
	manifest: AdminManifest | undefined,
): string[] | undefined {
	const pluginAdmins = usePluginAdmins();
	const config = manifest?.collections[collection];
	return React.useMemo(() => {
		if (!manifest || !config) return undefined;
		const pluginColumns = resolveContentListColumns(
			pluginAdmins,
			collection,
			Number.MAX_SAFE_INTEGER,
			manifest.plugins,
		);
		if (pluginColumns.length > 0) return undefined;
		const fields = new Set(["title", "name"]);
		if (config.titleField) fields.add(config.titleField);
		if (config.dateField && !SYSTEM_DATE_FIELDS.has(config.dateField)) {
			fields.add(config.dateField);
		}
		for (const slug of config.listColumns ?? []) fields.add(slug);
		return [...fields];
	}, [collection, config, manifest, pluginAdmins]);
}
