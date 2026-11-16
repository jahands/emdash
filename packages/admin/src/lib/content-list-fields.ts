import * as React from "react";

import type { AdminManifest } from "./api.js";
import { resolveContentListColumns } from "./content-list-columns.js";
import { usePluginAdmins, type PluginAdmins } from "./plugin-context.js";

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
	return React.useMemo(
		() => contentListFields(collection, manifest, pluginAdmins),
		[collection, manifest, pluginAdmins],
	);
}

/** `useContentListFields` outside React. */
export function contentListFields(
	collection: string,
	manifest: AdminManifest | undefined,
	pluginAdmins: PluginAdmins,
): string[] | undefined {
	const config = manifest?.collections[collection];
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
}
