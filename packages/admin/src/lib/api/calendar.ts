/**
 * Calendar API
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { queryOptions } from "@tanstack/react-query";

import { API_BASE, apiFetch, isTerminalRequestError, parseApiResponse } from "./client.js";

export interface CalendarEntry {
	collection: string;
	id: string;
	locale: string;
	title: string;
	/** The entry's current status. */
	status: string;
	/** `published` events sit at `published_at`, `scheduled` events at `scheduled_at`. */
	kind: "published" | "scheduled";
	at: string;
}

export interface CalendarRange {
	items: CalendarEntry[];
	/** More events exist than the calendar loads. */
	truncated: boolean;
}

/** The server's cap on one range. */
export const CALENDAR_MAX_ENTRIES = 1000;

export function calendarEntryKey(entry: Pick<CalendarEntry, "collection" | "id" | "kind">): string {
	return `${entry.collection}:${entry.id}:${entry.kind}`;
}

/** Loads the range's first `CALENDAR_MAX_ENTRIES` events, oldest first. */
export async function fetchCalendarRange(
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<CalendarRange> {
	const search = new URLSearchParams({ from, to });
	const response = await apiFetch(`${API_BASE}/calendar/range?${search.toString()}`, { signal });
	return parseApiResponse<CalendarRange>(response, i18n._(msg`Failed to load the calendar`));
}

export function calendarQueryOptions(from: string, to: string) {
	return queryOptions({
		queryKey: ["calendar", from, to] as const,
		queryFn: ({ signal }) => fetchCalendarRange(from, to, signal),
		retry: (failureCount, error) => !isTerminalRequestError(error) && failureCount < 1,
	});
}
