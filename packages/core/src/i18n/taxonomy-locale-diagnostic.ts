import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";
import { settleAll } from "../utils/settle.js";

const REPAIR_GUIDE =
	"https://docs.emdashcms.com/guides/internationalization/#repairing-taxonomy-locale-mismatches";

interface TaxonomyLocaleMismatch {
	source: "definitions" | "terms";
	locale: string;
}

/**
 * Warn when taxonomy definitions or terms use locales outside the configured
 * ones. `definitionLocales` may be given (or still loading) when the caller
 * already reads the definitions; the terms are read meanwhile.
 */
export async function warnAboutUnconfiguredTaxonomyLocales(
	db: Kysely<Database>,
	configuredLocales: readonly string[],
	definitionLocales?: readonly string[] | Promise<readonly string[]>,
): Promise<void> {
	const supportedLocales = configuredLocales.length > 0 ? configuredLocales : ["en"];
	const [definitionRows, termRows] = await settleAll([
		definitionLocales === undefined
			? db
					.selectFrom("_emdash_taxonomy_defs")
					.select("locale")
					.distinct()
					.where("locale", "not in", supportedLocales)
					.execute()
			: Promise.resolve(definitionLocales).then((locales) =>
					[...new Set(locales)]
						.filter((locale) => !supportedLocales.includes(locale))
						.map((locale) => ({ locale })),
				),
		db
			.selectFrom("taxonomies")
			.select("locale")
			.distinct()
			.where("locale", "not in", supportedLocales)
			.execute(),
	]);
	const mismatches: TaxonomyLocaleMismatch[] = [
		...definitionRows.map(({ locale }) => ({ source: "definitions" as const, locale })),
		...termRows.map(({ locale }) => ({ source: "terms" as const, locale })),
	].toSorted((a, b) => a.source.localeCompare(b.source) || a.locale.localeCompare(b.locale));
	if (mismatches.length === 0) return;

	const details = mismatches.map(({ source, locale }) => `${source}: ${locale}`).join("; ");
	console.warn(
		`EmDash: Taxonomy rows use locales outside the configured locales (${supportedLocales.join(", ")}): ${details}. ` +
			`Locale-scoped reads may not return these rows. Review and repair them explicitly: ${REPAIR_GUIDE}`,
	);
}
