import { ROUTE_MODULE_LOADERS } from "../route-module-loaders.js";
import { ADMIN_PREFETCH_MODULES, type AdminRouteModule } from "../route-modules.js";

/**
 * For each module in `ADMIN_PREFETCH_MODULES`, the files it needs beyond those
 * the admin page already loaded, as the server read them from the build.
 */
export type RoutePrefetchFiles = Partial<Record<AdminRouteModule, readonly string[]>>;

/** Leaves two of HTTP/1.1's six connections per host to requests the screen starts before downloads abort. */
const MAX_DOWNLOADS = 4;

let prefetchFiles: RoutePrefetchFiles = {};
let screenIdle = false;
const held = new Map<AdminRouteModule, number>();
const downloads = new Map<string, AbortController>();
const downloaded = new Set<string>();
const failed = new Set<string>();
const finished = new Set<AdminRouteModule>();
const watchedImages = new WeakSet<HTMLImageElement>();

/**
 * Sets the files to download ahead. Downloads are plain `fetch` requests,
 * which, unlike `import()`, can be aborted when the user navigates; the
 * module is imported from the HTTP cache once all its files are there.
 */
export function setRoutePrefetchFiles(files: RoutePrefetchFiles): void {
	prefetchFiles = files;
	pump();
}

/**
 * Called with `true` once the open screen has everything it asked for, and
 * with `false` as soon as it asks for more or the user navigates. Downloads
 * run only in between.
 */
export function setScreenIdle(idle: boolean): void {
	screenIdle = idle;
	if (idle) pump();
	else abortDownloads();
}

/**
 * Pauses background downloads while `module` loads for a screen that opens or
 * a link that shows intent, keeping the downloads of files it needs. Call the
 * returned function with whether it loaded.
 */
export function holdRoutePrefetch(module: AdminRouteModule): (loaded: boolean) => void {
	held.set(module, (held.get(module) ?? 0) + 1);
	abortDownloads();
	let released = false;
	return (success) => {
		if (released) return;
		released = true;
		const count = (held.get(module) ?? 1) - 1;
		if (count > 0) held.set(module, count);
		else held.delete(module);
		if (success) finished.add(module);
		pump();
	};
}

function abortDownloads(): void {
	const needed = new Set<string>();
	for (const module of held.keys()) {
		for (const file of prefetchFiles[module] ?? []) needed.add(file);
	}
	for (const [file, controller] of downloads) {
		if (!needed.has(file)) controller.abort();
	}
}

function pump(): void {
	if (!screenIdle || held.size > 0 || prefersReducedData() || imagesLoading()) return;
	for (const module of ADMIN_PREFETCH_MODULES) {
		if (finished.has(module)) continue;
		const files = prefetchFiles[module];
		if (!files) continue;
		let complete = true;
		for (const file of files) {
			if (failed.has(file)) {
				finished.add(module);
				complete = false;
				break;
			}
			if (downloaded.has(file)) continue;
			complete = false;
			if (downloads.has(file)) continue;
			if (downloads.size >= MAX_DOWNLOADS) return;
			download(file);
		}
		if (complete) importModule(module);
	}
}

function download(file: string): void {
	const controller = new AbortController();
	downloads.set(file, controller);
	void (async () => {
		try {
			const response = await fetch(file, { signal: controller.signal, priority: "low" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			await response.arrayBuffer();
			downloaded.add(file);
		} catch {
			if (!controller.signal.aborted) failed.add(file);
		} finally {
			if (downloads.get(file) === controller) downloads.delete(file);
			pump();
		}
	})();
}

/** Running a module costs main-thread time, so it waits for an idle moment. */
function importModule(module: AdminRouteModule): void {
	finished.add(module);
	window.requestIdleCallback(() => {
		if (!screenIdle || held.size > 0) {
			finished.delete(module);
			return;
		}
		ROUTE_MODULE_LOADERS[module]().catch(() => {});
	});
}

/**
 * Whether an image in view is still downloading. React Query going idle does
 * not mean the screen's images have arrived.
 */
function imagesLoading(): boolean {
	let loading = false;
	for (const image of document.images) {
		if (image.complete || !inView(image)) continue;
		loading = true;
		if (watchedImages.has(image)) continue;
		watchedImages.add(image);
		image.addEventListener("load", pump, { once: true });
		image.addEventListener("error", pump, { once: true });
	}
	return loading;
}

function inView(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.bottom > 0 &&
		rect.right > 0 &&
		rect.top < window.innerHeight &&
		rect.left < window.innerWidth
	);
}

function prefersReducedData(): boolean {
	const connection = (
		navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
	).connection;
	return (
		connection?.saveData === true ||
		connection?.effectiveType === "2g" ||
		connection?.effectiveType === "slow-2g"
	);
}
