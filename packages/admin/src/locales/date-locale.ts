import { useLingui } from "@lingui/react";
import * as React from "react";
import type { DayPickerLocale } from "react-day-picker/locale";
import { enUS } from "react-day-picker/locale/en-US";

import { LOCALES } from "./locales.js";

const DATE_LOCALE_BOOT_TIMEOUT_MS = 3000;

const loadedDateLocales = new Map<string, DayPickerLocale>();
const pendingDateLocales = new Map<string, Promise<DayPickerLocale>>();

/**
 * The date locale for an admin locale if it is available without loading:
 * US English for locales without a `dateLocale`, otherwise a previously loaded
 * one.
 */
export function getLoadedDateLocale(code: string): DayPickerLocale | undefined {
	const definition = LOCALES.find((locale) => locale.code === code);
	if (!definition?.dateLocale) return enUS;
	return loadedDateLocales.get(code);
}

/**
 * Loads the date locale for an admin locale. A locale that fails to load falls
 * back to US English and is not retried. Concurrent callers share one load.
 */
export function loadDateLocale(code: string): Promise<DayPickerLocale> {
	const loaded = getLoadedDateLocale(code);
	if (loaded) return Promise.resolve(loaded);
	let pending = pendingDateLocales.get(code);
	if (!pending) {
		pending = (async () => {
			let dateLocale = enUS;
			try {
				dateLocale = await LOCALES.find((locale) => locale.code === code)!.dateLocale!();
			} catch {
				// Fall back to US English for the rest of the session.
			}
			loadedDateLocales.set(code, dateLocale);
			pendingDateLocales.delete(code);
			return dateLocale;
		})();
		pendingDateLocales.set(code, pending);
	}
	return pending;
}

/**
 * Resolves once the date locale has loaded or `timeoutMs` has passed. The load
 * continues after a timeout, and `useDateLocale()` picks up its result.
 */
export async function waitForDateLocale(code: string, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([loadDateLocale(code), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Whether the date locale for an admin locale has loaded. Date locales can't be
 * serialized from the server, so the admin waits for this before showing
 * calendars, which would otherwise render with the US week start and then
 * shift. Turns true after a timeout so a stalled request can't block the admin.
 */
export function useDateLocaleReady(code: string): boolean {
	const [ready, setReady] = React.useState(() => getLoadedDateLocale(code) !== undefined);
	React.useEffect(() => {
		if (ready) return;
		let active = true;
		void (async () => {
			await waitForDateLocale(code, DATE_LOCALE_BOOT_TIMEOUT_MS);
			if (active) setReady(true);
		})();
		return () => {
			active = false;
		};
	}, [code, ready]);
	return ready;
}

/**
 * The date locale for the active admin locale. The admin loads it before
 * rendering and before switching locale, so this normally returns it
 * immediately; otherwise it returns US English until the load finishes.
 */
export function useDateLocale(): DayPickerLocale {
	const { i18n } = useLingui();
	const code = i18n.locale;
	const loaded = getLoadedDateLocale(code);
	const [, rerender] = React.useReducer((count: number) => count + 1, 0);

	React.useEffect(() => {
		if (loaded) return;
		let active = true;
		void (async () => {
			await loadDateLocale(code);
			if (active) rerender();
		})();
		return () => {
			active = false;
		};
	}, [code, loaded]);

	return loaded ?? enUS;
}
