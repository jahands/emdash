/**
 * Admin manifest endpoint - injected by EmDash integration
 *
 * GET /_emdash/api/manifest
 *
 * Returns the admin manifest with collection definitions and plugin info.
 * The manifest is generated from live database schema plus runtime plugin state.
 */

import type { APIRoute } from "astro";
import { sql } from "kysely";

import { apiSuccess, handleError } from "#api/error.js";
import { resolveSiteTitle } from "#api/site-title.js";
import { getAuthMode } from "#auth/mode.js";
import { MediaRepository } from "#db/repositories/media.js";
import { OptionsRepository } from "#db/repositories/options.js";

import { COMMIT, VERSION } from "../../../version.js";
import type { EmDashManifest } from "../../types.js";

export const prerender = false;

interface ManifestSiteOptions {
	adminBranding: EmDashManifest["admin"];
	siteTitle?: string;
	siteTimezone: string;
	staging: boolean;
}

/**
 * Read the site options shown in the admin shell. Precedence for the branded
 * name: explicit `admin.siteName`, then Site Title (Settings -> General), then
 * the title captured by the setup wizard, then the bundled "EmDash" default in
 * the SPA.
 */
async function readManifestSiteOptions(
	db: NonNullable<App.Locals["emdash"]>["db"] | undefined,
	configuredBranding: EmDashManifest["admin"],
): Promise<ManifestSiteOptions> {
	const result: ManifestSiteOptions = {
		adminBranding: configuredBranding,
		siteTimezone: "UTC",
		staging: false,
	};
	if (!db) return result;
	try {
		const options = new OptionsRepository(db);
		const titles = await options.getMany<string | boolean>([
			"site:title",
			"emdash:site_title",
			"site:timezone",
			"site:staging",
			"site:logo",
		]);
		const savedSiteTitle = titles.get("site:title");
		result.siteTitle =
			typeof savedSiteTitle === "string"
				? savedSiteTitle.trim() || undefined
				: resolveSiteTitle(undefined, titles.get("emdash:site_title"))?.trim() || undefined;
		const brandingSiteTitle = resolveSiteTitle(savedSiteTitle, titles.get("emdash:site_title"));
		const timezone = titles.get("site:timezone");
		result.siteTimezone = typeof timezone === "string" && timezone ? timezone : "UTC";
		result.staging = titles.get("site:staging") === true;
		if (!result.adminBranding?.siteName && brandingSiteTitle) {
			result.adminBranding = { ...result.adminBranding, siteName: brandingSiteTitle };
		}

		const siteLogo: unknown = titles.get("site:logo");
		if (
			!result.adminBranding?.logo &&
			typeof siteLogo === "object" &&
			siteLogo !== null &&
			"mediaId" in siteLogo &&
			typeof siteLogo.mediaId === "string"
		) {
			const media = await new MediaRepository(db).findById(siteLogo.mediaId);
			if (media) {
				result.adminBranding = {
					...result.adminBranding,
					logo: `/_emdash/api/media/file/${media.storageKey}`,
				};
			}
		}
	} catch {
		// options table may not exist yet (pre-setup) — keep the defaults.
	}
	return result;
}

/** Whether any allowed domain permits self-signup. */
async function isSignupEnabled(
	db: NonNullable<App.Locals["emdash"]>["db"] | undefined,
): Promise<boolean> {
	if (!db) return false;
	try {
		const result = await sql<{ cnt: unknown }>`
			SELECT COUNT(*) as cnt FROM allowed_domains WHERE enabled = 1
		`.execute(db);
		return Number(result.rows[0]?.cnt ?? 0) > 0;
	} catch {
		return false;
	}
}

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	try {
		const authMode = getAuthMode(emdash?.config);
		const providerManagedName =
			authMode.type === "external" &&
			!(
				typeof authMode.config === "object" &&
				authMode.config !== null &&
				"syncName" in authMode.config &&
				authMode.config.syncName === false
			);

		// Built fresh from the live database per admin request. `requestCached`
		// inside `getManifest` dedupes if multiple consumers share the request.
		// External auth providers handle their own signup, so only passkey auth
		// reads the allowed domains.
		const [emdashManifest, siteOptions, signupEnabled] = await Promise.all([
			emdash ? emdash.getManifest() : null,
			readManifestSiteOptions(emdash?.db, emdash?.config?.admin),
			authMode.type === "passkey" ? isSignupEnabled(emdash?.db) : false,
		]);
		const { adminBranding, siteTitle, siteTimezone, staging } = siteOptions;

		const manifest: EmDashManifest = emdashManifest
			? {
					...emdashManifest,
					siteTitle,
					timezone: siteTimezone,
					staging,
					authMode: authMode.type === "external" ? authMode.providerType : "passkey",
					providerManagedName,
					signupEnabled,
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
					admin: adminBranding,
				};

		return apiSuccess(manifest);
	} catch (error) {
		return handleError(error, "Failed to build manifest", "MANIFEST_BUILD_ERROR");
	}
};
