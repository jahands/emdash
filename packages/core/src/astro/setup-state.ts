/**
 * Which sites in this process have passed the admin setup check, keyed by the
 * runtime's config object. Setup does not become incomplete again, except
 * through the dev-only reset, which calls {@link forgetSetupComplete}.
 *
 * Lives on `globalThis` so every bundled copy of this module shares it.
 */

const CONFIRMED_KEY = Symbol.for("emdash:setup-confirmed");
const g = globalThis as Record<symbol, unknown>;

function confirmedConfigs(): WeakSet<object> {
	const existing = g[CONFIRMED_KEY];
	if (existing instanceof WeakSet) return existing;
	const created = new WeakSet<object>();
	g[CONFIRMED_KEY] = created;
	return created;
}

export function isSetupConfirmed(config: object | undefined): boolean {
	return !!config && confirmedConfigs().has(config);
}

export function confirmSetupComplete(config: object | undefined): void {
	if (config) confirmedConfigs().add(config);
}

/** Make the next admin request check setup state again. */
export function forgetSetupComplete(config: object | undefined): void {
	if (config) confirmedConfigs().delete(config);
}
