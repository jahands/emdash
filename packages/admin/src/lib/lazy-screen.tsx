import * as React from "react";

const CHUNK_URL = /https?:\/\/[^\s]+/;

const failedScreens = new Set<() => void>();

async function isMissingChunk(error: unknown): Promise<boolean> {
	if (typeof window === "undefined" || !navigator.onLine || !(error instanceof Error)) return false;
	const match = error.message.match(CHUNK_URL);
	if (!match) return false;
	const url = new URL(match[0]);
	if (url.origin !== window.location.origin || !url.pathname.endsWith(".js")) return false;
	try {
		const response = await fetch(url, {
			method: "HEAD",
			cache: "no-store",
			signal: AbortSignal.timeout(1500),
		});
		return response.status === 404 || response.status === 410;
	} catch {
		return false;
	}
}

export function retryFailedScreens() {
	for (const reset of failedScreens) reset();
	failedScreens.clear();
}

export function lazyRouteComponent<T extends Record<string, unknown>, K extends keyof T>(
	importer: () => Promise<T>,
	exportName: K,
): T[K] & { preload: () => Promise<void> } {
	let component: React.ComponentType | undefined;
	let pending: Promise<void> | undefined;
	let failure: unknown;
	let missing = false;
	const reset = () => {
		pending = undefined;
		failure = undefined;
		missing = false;
	};
	const load = () =>
		(pending ??= importer()
			.then((module) => {
				component = module[exportName] as React.ComponentType;
				failedScreens.delete(reset);
				return undefined;
			})
			.catch(async (error: unknown) => {
				missing = await isMissingChunk(error);
				failure = error;
				failedScreens.add(reset);
			}));
	function LazyScreen(props: Record<string, unknown>) {
		if (missing) {
			let shouldReload = false;
			try {
				const key = `emdash:chunk-reload:${failure instanceof Error ? failure.message : window.location.pathname}`;
				shouldReload = !sessionStorage.getItem(key);
				if (shouldReload) sessionStorage.setItem(key, "1");
			} catch {
				shouldReload = false;
			}
			if (shouldReload) {
				window.location.reload();
				throw new Promise(() => {});
			}
		}
		if (failure) throw failure;
		if (!component) throw load();
		return React.createElement(component, props);
	}
	LazyScreen.preload = load;
	return LazyScreen as T[K] & { preload: () => Promise<void> };
}
