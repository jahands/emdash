import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { ROUTE_MODULE_LOADERS, type RouteModuleExports } from "../route-module-loaders.js";
import {
	ADMIN_EDITOR_MODULES,
	adminRouteModules,
	type AdminRouteModule,
} from "../route-modules.js";

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
		try {
			const exports = await ROUTE_MODULE_LOADERS[module]();
			Component = (exports as Record<K, unknown>)[exportName] as React.ComponentType<Props>;
			failed = false;
		} catch {
			failed = true;
			pending = undefined;
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
		const [, rerender] = React.useReducer((count: number) => count + 1, 0);
		if (Component) return <Component {...props} />;
		if (failed) {
			return <RouteModuleError module={module} onRetry={() => void preload().then(rerender)} />;
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

let prefetched = false;

/** Whether the route at `path` (a route path or URL path below the admin base) shows the editor. */
export function routeLoadsEditor(path: string | undefined): boolean {
	return (
		path !== undefined && adminRouteModules(path).some((module) => ADMIN_EDITOR_MODULES.has(module))
	);
}

/** Loads every route module except the editor's, for screens not yet visited. */
export function prefetchRouteModules(): void {
	if (prefetched) return;
	prefetched = true;
	for (const [module, load] of Object.entries(ROUTE_MODULE_LOADERS)) {
		if (ADMIN_EDITOR_MODULES.has(module as AdminRouteModule)) continue;
		load().catch(() => {});
	}
}

/**
 * Shown when a route module fails to load. Online, the likeliest cause is a
 * deploy that replaced the admin's files, so the page reloads once.
 */
function RouteModuleError({ module, onRetry }: { module: AdminRouteModule; onRetry: () => void }) {
	const { t } = useLingui();
	React.useEffect(() => {
		if (shouldReload(module)) window.location.reload();
	}, [module]);
	return (
		<div className="flex items-center justify-center min-h-[50vh]">
			<div className="text-center" role="alert">
				<h1 className="text-2xl font-semibold leading-tight">{t`This page couldn't load`}</h1>
				<p className="mt-2 text-sm text-kumo-subtle">{t`Check your connection, then try again.`}</p>
				<Button onClick={onRetry} className="mt-4">
					{t`Try again`}
				</Button>
			</div>
		</div>
	);
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
