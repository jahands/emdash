/**
 * The admin modules each route loads on demand, keyed by route path below the
 * admin base path. Every route is listed, so a URL matches the route the
 * router picks. Each module is a separate build entry (`dist/<module>.js`),
 * so the admin page can preload the current route's modules with the rest of
 * the admin instead of after it.
 *
 * Kept free of imports: EmDash core reads it on the server.
 */
export const ADMIN_ROUTE_MODULES = {
	"/setup": ["components/SetupWizard"],
	"/login": ["components/LoginPage"],
	"/login/magic-link": ["components/MagicLinkConfirmPage"],
	"/signup": ["components/SignupPage"],
	"/invite/accept": ["components/InviteAcceptPage"],
	"/device": ["components/DeviceAuthorizePage"],
	"/": ["components/Dashboard"],
	"/calendar": ["routes/calendar"],
	"/content/$collection": ["components/ContentList"],
	"/content/$collection/new": ["components/ContentEditor"],
	"/content/$collection/$id": ["components/ContentEditor"],
	"/content-types": ["components/ContentTypeList", "components/BlockTypeList"],
	"/content-types/new": ["components/ContentTypeEditor"],
	"/content-types/relations": ["components/RelationList"],
	"/content-types/$slug": ["components/ContentTypeEditor"],
	"/media": ["components/MediaLibrary"],
	"/comments": ["components/comments/CommentInbox"],
	"/menus": ["components/MenuList"],
	"/menus/$name": ["components/MenuEditor"],
	"/plugins-manager": ["components/PluginManager"],
	"/plugins-manager/$pluginId/settings": ["components/PluginSettings"],
	"/plugins/marketplace": [],
	"/plugins/marketplace/$pluginId": [],
	"/plugins/registry": ["components/RegistryBrowse"],
	"/plugins/registry/$publisher/$slug": ["components/RegistryPluginDetail"],
	"/plugins/$pluginId/$": ["components/SandboxedPluginPage"],
	"/redirects": ["components/Redirects"],
	"/sections": ["components/Sections"],
	"/sections/$slug": ["components/SectionEditor"],
	"/taxonomies/$taxonomy": ["components/TaxonomyManager"],
	"/users": ["routes/users"],
	"/bylines": ["routes/bylines"],
	"/byline-schema": ["routes/byline-schema"],
	"/widgets": ["components/Widgets"],
	"/settings": ["components/Settings"],
	"/settings/media-usage": ["components/settings/MediaUsageSettings"],
	"/settings/general": ["components/settings/GeneralSettings"],
	"/settings/social": ["components/settings/SocialSettings"],
	"/settings/seo": ["components/settings/SeoSettings"],
	"/settings/security": ["components/settings/SecuritySettings"],
	"/settings/allowed-domains": ["components/settings/AllowedDomainsSettings"],
	"/settings/api-tokens": ["components/settings/ApiTokenSettings"],
	"/settings/email": ["components/settings/EmailSettings"],
	"/settings/backups": ["components/settings/BackupSettings"],
	"/settings/transfer": ["components/settings/TransferSettings"],
	"/settings/sidebars": ["components/settings/SidebarsSettings"],
	"/import/wordpress": ["components/WordPressImport"],
	"/themes/marketplace": [],
	"/themes/marketplace/$themeId": [],
	"/$": [],
} as const satisfies Record<string, readonly string[]>;

export type AdminRoutePath = keyof typeof ADMIN_ROUTE_MODULES;
export type AdminRouteModule = Exclude<
	(typeof ADMIN_ROUTE_MODULES)[AdminRoutePath][number],
	undefined
>;

/**
 * Modules that bring in the rich text editor. They load only when their route
 * is entered or a link to it shows intent, never in the background.
 */
export const ADMIN_EDITOR_MODULES: ReadonlySet<AdminRouteModule> = new Set<AdminRouteModule>([
	"components/ContentEditor",
	"components/SectionEditor",
	"components/Widgets",
]);

function segments(path: string): string[] {
	return path.split("/").filter(Boolean);
}

/** Ranks a route segment: a static segment beats a parameter, which beats a splat. */
function segmentRank(segment: string): number {
	if (segment === "$") return 0;
	return segment.startsWith("$") ? 1 : 2;
}

function matches(pattern: string[], path: string[]): boolean {
	for (const [index, segment] of pattern.entries()) {
		if (segment === "$") return path.length > index;
		const value = path[index];
		if (value === undefined) return false;
		if (!segment.startsWith("$") && segment !== value) return false;
	}
	return pattern.length === path.length;
}

function moreSpecific(a: string[], b: string[]): boolean {
	for (const [index, segment] of a.entries()) {
		const other = b[index];
		if (other === undefined) return true;
		const difference = segmentRank(segment) - segmentRank(other);
		if (difference !== 0) return difference > 0;
	}
	return false;
}

/**
 * The modules the route at `pathname` loads, where `pathname` is relative to
 * the admin base path (`/content/posts`, not `/_emdash/admin/content/posts`).
 */
export function adminRouteModules(pathname: string): readonly AdminRouteModule[] {
	const path = segments(pathname);
	let best: { pattern: string[]; modules: readonly AdminRouteModule[] } | undefined;
	for (const [candidate, modules] of Object.entries(ADMIN_ROUTE_MODULES)) {
		const pattern = segments(candidate);
		if (!matches(pattern, path)) continue;
		if (!best || moreSpecific(pattern, best.pattern)) best = { pattern, modules };
	}
	return best?.modules ?? [];
}
