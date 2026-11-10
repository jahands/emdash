import { useLocation, useMatch } from "@tanstack/react-router";
import * as React from "react";

/** How many history entries keep their saved state before the oldest are dropped. */
const MAX_ENTRIES = 50;

const STORAGE_KEY = "emdash-history-entries";

type EntryValues = Record<string, unknown>;

function isEntry(value: unknown): value is [string, EntryValues] {
	return (
		Array.isArray(value) &&
		typeof value[0] === "string" &&
		typeof value[1] === "object" &&
		value[1] !== null
	);
}

function readEntries(): Array<[string, EntryValues]> {
	try {
		const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
	} catch {
		return [];
	}
}

function readEntryValue(entryKey: string, name: string): unknown {
	return readEntries().find(([key]) => key === entryKey)?.[1][name];
}

function writeEntryValue(entryKey: string, name: string, value: unknown) {
	const entries = readEntries();
	const existing = entries.findIndex(([key]) => key === entryKey);
	const [, values] = existing === -1 ? [entryKey, {}] : entries[existing]!;
	if (existing !== -1) entries.splice(existing, 1);
	values[name] = value;
	entries.push([entryKey, values]);
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
	} catch {
		// Storage unavailable or full: the state just isn't remembered for Back.
	}
}

/**
 * The key of the history entry this route's page belongs to. While a navigation away is
 * pending, the router already reports the next location but still shows this page, so the
 * key only follows locations that this page's own route matches.
 */
function useHistoryEntryKey(): string {
	const pagePathname = useMatch({ strict: false, select: (match) => match.pathname });
	const locationKey = useLocation({
		select: (location) => location.state.__TSR_key ?? location.href,
	});
	const locationPathname = useLocation({ select: (location) => location.pathname });
	const key = React.useRef(locationKey);
	if (locationPathname === pagePathname) key.current = locationKey;
	return key.current;
}

/**
 * `useState` that is saved against the current history entry, so Back and Forward return
 * to the value the entry last had. A new entry starts with the value it was opened with.
 * `value` must be JSON-serializable; `isValue` rejects a saved value of another shape, such
 * as one saved by an older admin version.
 */
export function useHistoryEntryState<T>(
	name: string,
	initialValue: T,
	isValue: (value: unknown) => value is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
	const entryKey = useHistoryEntryKey();
	const [value, setValue] = React.useState<T>(() => {
		const saved = readEntryValue(entryKey, name);
		return isValue(saved) ? saved : initialValue;
	});

	const [seenKey, setSeenKey] = React.useState(entryKey);
	if (seenKey !== entryKey) {
		setSeenKey(entryKey);
		const saved = readEntryValue(entryKey, name);
		if (isValue(saved)) setValue(saved);
	}

	React.useEffect(() => {
		writeEntryValue(entryKey, name, value);
	}, [entryKey, name, value]);

	return [value, setValue];
}

/**
 * Keeps the admin `<main>` scroll offset with the current history entry and restores it on
 * return. `ready` holds restoration back until the content that gives the page its height
 * has rendered.
 */
export function useRestoreMainScroll(ready: boolean) {
	const entryKey = useHistoryEntryKey();

	React.useLayoutEffect(() => {
		if (!ready) return;
		const main = document.querySelector("main");
		if (!main) return;

		const saved = readEntryValue(entryKey, "scrollTop");
		if (typeof saved === "number") main.scrollTop = saved;
		else writeEntryValue(entryKey, "scrollTop", main.scrollTop);

		const onScroll = () => writeEntryValue(entryKey, "scrollTop", main.scrollTop);
		main.addEventListener("scroll", onScroll, { passive: true });
		return () => main.removeEventListener("scroll", onScroll);
	}, [entryKey, ready]);
}
