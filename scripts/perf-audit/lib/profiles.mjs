/**
 * Production profiles: a shipped template plus the platform it runs on.
 *
 * A profile id is `<template>-<platform>`, for example `blog-workerd-d1`.
 * Node platforms materialize from `templates/<template>`, workerd platforms
 * from `templates/<template>-cloudflare`.
 */

export const TEMPLATES = ["blog", "portfolio", "marketing", "starter"];

export const PLATFORMS = {
	"node-sqlite": { runtime: "node", database: "sqlite", images: "sharp" },
	"node-postgres": { runtime: "node", database: "postgres", images: "sharp" },
	"workerd-d1": { runtime: "workerd", database: "d1", images: "binding" },
	"workerd-d1-url-images": { runtime: "workerd", database: "d1", images: "url" },
	"workerd-postgres": { runtime: "workerd", database: "hyperdrive", images: "binding" },
	"workerd-postgres-url-images": { runtime: "workerd", database: "hyperdrive", images: "url" },
};

const DEFAULT_PLATFORMS = [
	"node-sqlite",
	"node-postgres",
	"workerd-d1",
	"workerd-d1-url-images",
	"workerd-postgres",
];

export const BASE_PORT = 14600;

export function profileId(template, platform) {
	return `${template}-${platform}`;
}

export function allProfileIds() {
	return TEMPLATES.flatMap((template) =>
		Object.keys(PLATFORMS).map((platform) => profileId(template, platform)),
	);
}

export function defaultProfileIds() {
	return DEFAULT_PLATFORMS.map((platform) => profileId("blog", platform));
}

/**
 * Resolve a profile id into its template, platform and fixed ports. Ports
 * are derived from the id's position in the full list so a profile keeps the
 * same origin across runs: the origin is baked into `siteUrl` at build time.
 */
export function resolveProfile(id) {
	const template = TEMPLATES.find((t) => id.startsWith(`${t}-`));
	const platform = template ? id.slice(template.length + 1) : undefined;
	const spec = platform ? PLATFORMS[platform] : undefined;
	if (!template || !platform || !spec) {
		throw new Error(`Unknown profile "${id}". Run with --list to see the available profiles.`);
	}
	const index = allProfileIds().indexOf(id);
	const port = BASE_PORT + index * 4;
	return {
		id,
		template,
		platform,
		...spec,
		sourceTemplate: spec.runtime === "workerd" ? `${template}-cloudflare` : template,
		port,
		proxyPort: port + 1,
		origin: `http://localhost:${port}`,
		usesPostgres: spec.database === "postgres" || spec.database === "hyperdrive",
	};
}

export function selectProfiles({ profiles, profileSet }) {
	if (profiles.length > 0) return Array.from(new Set(profiles), resolveProfile);
	const ids = profileSet === "all" ? allProfileIds() : defaultProfileIds();
	return ids.map(resolveProfile);
}
