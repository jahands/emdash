import type { Messages } from "@lingui/core";

import { DEFAULT_LOCALE } from "./config.js";

const SERVER_CATALOG_LOADERS = import.meta.glob<{ messages: Messages }>("./*/server-catalog.mjs");

/**
 * Loads the messages that server-side modules resolve (visual editing toolbar
 * and system emails) for a locale, falling back to the default locale. Unlike
 * `loadMessages`, this never bundles whole admin catalogs into the server.
 */
export async function loadServerMessages(locale: string): Promise<Messages> {
	const loader =
		SERVER_CATALOG_LOADERS[`./${locale}/server-catalog.mjs`] ??
		SERVER_CATALOG_LOADERS[`./${DEFAULT_LOCALE}/server-catalog.mjs`];
	if (!loader) {
		throw new Error(
			`No server locale catalog found for "${locale}" or "${DEFAULT_LOCALE}". Run \`pnpm build\` in packages/admin to generate catalogs.`,
		);
	}
	const { messages } = await loader();
	return messages;
}
