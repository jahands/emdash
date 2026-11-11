/**
 * The screens each profile measures.
 */

export const SETTINGS_SUBPAGES = [
	"general",
	"media-usage",
	"security",
	"allowed-domains",
	"api-tokens",
	"email",
	"backups",
	"transfer",
	"sidebars",
	"social",
	"seo",
];

/**
 * Admin screens that need no seeded record. The plugin and theme
 * marketplaces are left out: they load from external registries.
 */
export const OTHER_ADMIN_SCREENS = [
	["calendar", "/calendar"],
	["comments", "/comments"],
	["bylines", "/bylines"],
	["byline schema", "/byline-schema"],
	["content types", "/content-types"],
	["new content type", "/content-types/new"],
	["content type relations", "/content-types/relations"],
	["redirects", "/redirects"],
	["widgets", "/widgets"],
	["sections", "/sections"],
	["plugins", "/plugins-manager"],
	["WordPress import", "/import/wordpress"],
];

const admin = (name, path) => ({ name, path: `/_emdash/admin${path}`, kind: "admin" });
const pub = (name, path) => ({ name, path, kind: "public" });

const PUBLIC_ROUTES = {
	blog: { entry: (slug) => `/posts/${slug}`, archive: (term) => `/category/${term}` },
	starter: { entry: (slug) => `/posts/${slug}`, archive: (term) => `/category/${term}` },
	portfolio: { entry: (slug) => `/work/${slug}`, archive: null },
	marketing: { entry: (slug) => `/${slug}`, archive: null },
};

/**
 * Build the measured screens from the seeded site: its collections,
 * the entry with the most images, a taxonomy and a menu.
 */
export function buildTargets({
	template,
	collections,
	heaviest,
	taxonomy,
	term,
	menu,
	firstPageSlug,
}) {
	const targets = [
		{ ...admin("admin login (signed out)", "/login"), signedOut: true },
		admin("admin dashboard", "/"),
	];
	for (const slug of collections) targets.push(admin(`admin list ${slug}`, `/content/${slug}`));
	const mainCollection = heaviest?.collection ?? collections[0];
	if (heaviest) {
		targets.push(
			admin("admin editor (most images)", `/content/${heaviest.collection}/${heaviest.id}`),
		);
	}
	if (mainCollection) {
		targets.push(admin(`admin new ${mainCollection}`, `/content/${mainCollection}/new`));
		targets.push(admin(`admin content type ${mainCollection}`, `/content-types/${mainCollection}`));
	}
	targets.push(admin("admin media library", "/media"));
	targets.push(admin("admin settings", "/settings"));
	for (const sub of SETTINGS_SUBPAGES)
		targets.push(admin(`admin settings ${sub}`, `/settings/${sub}`));
	targets.push(admin("admin menus", "/menus"));
	if (menu) targets.push(admin(`admin menu ${menu}`, `/menus/${menu}`));
	if (taxonomy) targets.push(admin(`admin taxonomy ${taxonomy}`, `/taxonomies/${taxonomy}`));
	targets.push(admin("admin users", "/users"));
	for (const [name, path] of OTHER_ADMIN_SCREENS) targets.push(admin(`admin ${name}`, path));

	const routes = PUBLIC_ROUTES[template];
	targets.push(pub("public home", "/"));
	if (heaviest && routes?.entry)
		targets.push(pub("public entry (most images)", routes.entry(heaviest.slug)));
	else if (firstPageSlug && routes?.entry)
		targets.push(pub("public entry", routes.entry(firstPageSlug)));
	if (term && routes?.archive) targets.push(pub(`public archive ${term}`, routes.archive(term)));
	return targets;
}

export function filterTargets(targets, only) {
	if (!only || only.length === 0) return targets;
	return targets.filter((t) => only.some((o) => t.path.includes(o) || t.name.includes(o)));
}
