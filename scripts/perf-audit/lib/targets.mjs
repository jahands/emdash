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
	const targets = [admin("admin dashboard", "/")];
	for (const slug of collections) targets.push(admin(`admin list ${slug}`, `/content/${slug}`));
	if (heaviest) {
		targets.push(
			admin("admin editor (most images)", `/content/${heaviest.collection}/${heaviest.id}`),
		);
	}
	targets.push(admin("admin media library", "/media"));
	targets.push(admin("admin settings", "/settings"));
	for (const sub of SETTINGS_SUBPAGES)
		targets.push(admin(`admin settings ${sub}`, `/settings/${sub}`));
	targets.push(admin("admin menus", "/menus"));
	if (menu) targets.push(admin(`admin menu ${menu}`, `/menus/${menu}`));
	if (taxonomy) targets.push(admin(`admin taxonomy ${taxonomy}`, `/taxonomies/${taxonomy}`));
	targets.push(admin("admin users", "/users"));

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
