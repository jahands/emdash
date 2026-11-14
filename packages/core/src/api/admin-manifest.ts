import { sql } from "kysely";

import { resolveSiteTitle } from "#api/site-title.js";
import { getAuthMode } from "#auth/mode.js";
import { MediaRepository } from "#db/repositories/media.js";
import { OptionsRepository } from "#db/repositories/options.js";

import type { EmDashHandlers, EmDashManifest } from "../astro/types.js";
import { settleAll } from "../utils/settle.js";
import { COMMIT, VERSION } from "../version.js";

/**
 * The admin manifest the SPA boots from: collection definitions and plugin
 * info from the live schema, plus site branding and auth settings.
 */
export async function buildAdminManifest(
	emdash: EmDashHandlers | undefined,
): Promise<EmDashManifest> {
	// Determine auth mode from config
	const authMode = getAuthMode(emdash?.config);

	// Manifest is built fresh from the live database per admin request.
	// `requestCached` inside `getManifest` dedupes if multiple consumers
	// share the request. The options and signup reads below don't depend on
	// it and run at the same time.
	const manifestPromise = emdash ? emdash.getManifest() : Promise.resolve(null);
	const db = emdash?.db;
	const optionsPromise = db
		? new OptionsRepository(db)
				.getMany<string | boolean>([
					"site:title",
					"emdash:site_title",
					"site:timezone",
					"site:staging",
					"site:logo",
				])
				.catch(() => null)
		: Promise.resolve(null);
	// Self-signup (any allowed domain with enabled = 1) only applies to
	// passkey auth — external auth providers handle their own signup.
	const signupPromise =
		db && authMode.type === "passkey"
			? sql<{ cnt: unknown }>`
					SELECT COUNT(*) as cnt FROM allowed_domains WHERE enabled = 1
				`
					.execute(db)
					.then((result) => Number(result.rows[0]?.cnt ?? 0) > 0)
					// Table may not exist yet, that's fine
					.catch(() => false)
			: Promise.resolve(false);
	const [emdashManifest, titles, signupEnabled] = await settleAll([
		manifestPromise,
		optionsPromise,
		signupPromise,
	]);
	const providerManagedName =
		authMode.type === "external" &&
		!(
			typeof authMode.config === "object" &&
			authMode.config !== null &&
			"syncName" in authMode.config &&
			authMode.config.syncName === false
		);

	// Read admin branding from the per-request config plumbed through middleware
	// (same source admin.astro reads from). Reading from a build-time global
	// here was unreliable -- the virtual config module exports the config but
	// doesn't assign it to globalThis, so getStoredConfig() always returned
	// null and the React SPA never received custom logo/siteName/favicon.
	// See issue #835.
	let adminBranding = emdash?.config?.admin;
	let siteTitle: string | undefined;
	let siteTimezone = "UTC";
	let staging = false;

	// Read the site timezone alongside the title fallback so datetime controls
	// and branding share one options query. When no build-time `admin.siteName`
	// is configured, brand the admin with
	// the site's own title so multi-site operators can tell backends apart
	// (WordPress-style: wp-admin always shows the site name). Precedence:
	// explicit `admin.siteName` → Site Title (Settings → General) → the title
	// captured by the setup wizard → the bundled "EmDash" default in the SPA.
	// options table may not exist yet (pre-setup) — keep the defaults.
	if (db && titles) {
		try {
			const savedSiteTitle = titles.get("site:title");
			siteTitle =
				typeof savedSiteTitle === "string"
					? savedSiteTitle.trim() || undefined
					: resolveSiteTitle(undefined, titles.get("emdash:site_title"))?.trim() || undefined;
			const brandingSiteTitle = resolveSiteTitle(savedSiteTitle, titles.get("emdash:site_title"));
			const timezone = titles.get("site:timezone");
			siteTimezone = typeof timezone === "string" && timezone ? timezone : "UTC";
			staging = titles.get("site:staging") === true;
			if (!adminBranding?.siteName && brandingSiteTitle) {
				adminBranding = { ...adminBranding, siteName: brandingSiteTitle };
			}

			const siteLogo: unknown = titles.get("site:logo");
			if (
				!adminBranding?.logo &&
				typeof siteLogo === "object" &&
				siteLogo !== null &&
				"mediaId" in siteLogo &&
				typeof siteLogo.mediaId === "string"
			) {
				const media = await new MediaRepository(db).findById(siteLogo.mediaId);
				if (media) {
					adminBranding = {
						...adminBranding,
						logo: `/_emdash/api/media/file/${media.storageKey}`,
					};
				}
			}
		} catch {
			// The logo's media lookup failed — keep the default.
		}
	}

	return emdashManifest
		? {
				...emdashManifest,
				siteTitle,
				timezone: siteTimezone,
				staging,
				coEditing: Boolean(emdash?.rooms),
				authMode: authMode.type === "external" ? authMode.providerType : "passkey",
				providerManagedName,
				signupEnabled,
				storageAvailable: Boolean(emdash?.storage),
				admin: adminBranding,
			}
		: {
				version: VERSION,
				commit: COMMIT,
				hash: "default",
				collections: {},
				plugins: {},
				siteTitle,
				timezone: siteTimezone,
				staging,
				taxonomies: [],
				authMode: "passkey",
				providerManagedName,
				signupEnabled,
				storageAvailable: Boolean(emdash?.storage),
				admin: adminBranding,
			};
}
