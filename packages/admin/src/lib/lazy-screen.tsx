import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import * as React from "react";

import { reloadPage } from "./page-reload.js";

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

function whenMutationsSettle(queryClient: QueryClient): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = queryClient.getMutationCache().subscribe(() => {
			if (queryClient.isMutating() > 0) return;
			unsubscribe();
			resolve();
		});
	});
}

/** Allows one reload per missing chunk, so a chunk that stays missing shows the error instead. */
function claimReload(failure: unknown): boolean {
	try {
		const key = `emdash:chunk-reload:${failure instanceof Error ? failure.message : window.location.pathname}`;
		if (sessionStorage.getItem(key)) return false;
		sessionStorage.setItem(key, "1");
		return true;
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
	let waitingForMutations: Promise<void> | undefined;
	let reloading: Promise<never> | undefined;
	function LazyScreen(props: Record<string, unknown>) {
		const queryClient = useQueryClient();
		if (missing) {
			if (reloading) throw reloading;
			// A reload aborts requests in flight, such as a save sent as the editor was left.
			if (queryClient.isMutating() > 0) {
				throw (waitingForMutations ??= whenMutationsSettle(queryClient).finally(() => {
					waitingForMutations = undefined;
				}));
			}
			if (claimReload(failure)) {
				reloading = new Promise<never>(() => {});
				reloadPage();
				throw reloading;
			}
		}
		if (failure) throw failure;
		if (!component) throw load();
		return React.createElement(component, props);
	}
	LazyScreen.preload = load;
	return LazyScreen as T[K] & { preload: () => Promise<void> };
}
