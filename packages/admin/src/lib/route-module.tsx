import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { ROUTE_MODULE_LOADERS, type RouteModuleExports } from "../route-module-loaders.js";
import {
	ADMIN_EDITOR_MODULES,
	adminRouteModules,
	type AdminRouteModule,
} from "../route-modules.js";
import { reloadPage } from "./reload-page.js";
import { holdRoutePrefetch } from "./route-prefetch.js";

/** What a route component needs loaded before the router renders it. */
export interface RouteModulePreload {
	preload: () => Promise<void>;
	modules: readonly AdminRouteModule[];
}

type ComponentExport<T> = {
	[K in keyof T]: T[K] extends React.ComponentType<never> ? K : never;
}[keyof T];

type PropsOf<T> = T extends React.ComponentType<infer P> ? P : never;

const RELOADED_KEY = "emdash:route-module-reloaded";

/**
 * A component loaded from a route module. Routes preload it before they
 * render (see `withRouteModules`), so it renders synchronously; rendering it
 * earlier suspends.
 */
export function lazyRouteModule<
	M extends AdminRouteModule,
	K extends ComponentExport<RouteModuleExports<M>>,
>(module: M, exportName: K) {
	type Props = PropsOf<RouteModuleExports<M>[K]>;
	let Component: React.ComponentType<Props> | undefined;
	let pending: Promise<void> | undefined;
	let failed = false;

	const load = async () => {
		const release = holdRoutePrefetch(module);
		try {
			const exports = await ROUTE_MODULE_LOADERS[module]();
			Component = (exports as Record<K, unknown>)[exportName] as React.ComponentType<Props>;
			failed = false;
			forgetReload(module);
		} catch {
			failed = true;
			pending = undefined;
		} finally {
			release(!failed);
		}
	};

	// Never rejects: the router keeps a rejected preload for good, so a failed
	// load is shown by the component instead and retried from there.
	const preload = (): Promise<void> => {
		if (Component) return Promise.resolve();
		pending ??= load();
		return pending;
	};

	function RouteModule(props: Props & React.JSX.IntrinsicAttributes) {
		const [attempt, rerender] = React.useReducer((count: number) => count + 1, 0);
		if (Component) return <Component {...props} />;
		if (failed) {
			return (
				<RouteModuleError
					key={attempt}
					module={module}
					onRetry={() => void preload().then(rerender)}
				/>
			);
		}
		throw preload();
	}

	return Object.assign(RouteModule, { preload, modules: [module] as const });
}

/** `Page`, made to load the route modules it renders before the router shows it. */
export function withRouteModules<Page extends (props: never) => React.ReactNode>(
	Page: Page,
	...components: RouteModulePreload[]
): Page & RouteModulePreload {
	return Object.assign(Page, {
		preload: async () => {
			await Promise.all(components.map((component) => component.preload()));
		},
		modules: components.flatMap((component) => component.modules),
	});
}

/** Whether the route at `path` (a route path or URL path below the admin base) shows the editor. */
export function routeLoadsEditor(path: string | undefined): boolean {
	return (
		path !== undefined && adminRouteModules(path).some((module) => ADMIN_EDITOR_MODULES.has(module))
	);
}

type LoadFailure = "offline" | "unreachable" | "outdated";

/**
 * Shown when a route module fails to load. Online, the likeliest cause is a
 * deploy that replaced the admin's files, so the page reloads once.
 */
function RouteModuleError({ module, onRetry }: { module: AdminRouteModule; onRetry: () => void }) {
	const { t } = useLingui();
	const [failure, setFailure] = React.useState<LoadFailure | undefined>(() =>
		navigator.onLine ? undefined : "offline",
	);

	React.useEffect(() => {
		const goOffline = () => setFailure("offline");
		const goOnline = () => onRetry();
		window.addEventListener("offline", goOffline);
		window.addEventListener("online", goOnline);
		return () => {
			window.removeEventListener("offline", goOffline);
			window.removeEventListener("online", goOnline);
		};
	}, [onRetry]);

	React.useEffect(() => {
		if (!navigator.onLine) return;
		if (shouldReload(module)) {
			reloadPage();
			return;
		}
		let active = true;
		void (async () => {
			const reachable = await serverReachable();
			if (active && navigator.onLine) setFailure(reachable ? "outdated" : "unreachable");
		})();
		return () => {
			active = false;
		};
	}, [module]);

	const outdated = failure === "outdated";
	return (
		<div className="flex items-center justify-center min-h-[50vh] p-4">
			<div className="flex flex-col items-center text-center" role="alert">
				<h1 className="text-2xl font-semibold leading-tight">
					{failure === "offline" ? t`You're offline` : t`This page couldn't load`}
				</h1>
				{failure && (
					<p className="mt-2 text-sm text-kumo-subtle">
						{failure === "offline"
							? t`This page will load when you're back online.`
							: failure === "unreachable"
								? t`The server can't be reached. Check your connection, then try again.`
								: t`The admin may have been updated. Reload the page to get the latest version.`}
					</p>
				)}
				<Button onClick={outdated ? reloadPage : onRetry} className="mt-4">
					{outdated ? t`Reload page` : t`Try again`}
				</Button>
			</div>
		</div>
	);
}

/** Any response, even an error status, means the browser can reach the server. */
async function serverReachable(): Promise<boolean> {
	try {
		await fetch(window.location.href, { method: "HEAD", cache: "no-store" });
		return true;
	} catch {
		return false;
	}
}

function shouldReload(module: AdminRouteModule): boolean {
	if (!navigator.onLine) return false;
	const key = `${RELOADED_KEY}:${module}`;
	try {
		if (sessionStorage.getItem(key)) return false;
		sessionStorage.setItem(key, "1");
		return true;
	} catch {
		return false;
	}
}

/** Lets the next deploy that removes `module`'s files reload the page again. */
function forgetReload(module: AdminRouteModule): void {
	try {
		sessionStorage.removeItem(`${RELOADED_KEY}:${module}`);
	} catch {
		// Without storage the page never reloads, so there is nothing to reset.
	}
}
