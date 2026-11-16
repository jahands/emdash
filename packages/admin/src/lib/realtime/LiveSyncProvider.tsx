/**
 * Live queries. A query opts in with `meta: { live: ["content/posts"] }`: while it has observers
 * the tab subscribes to those topics, and when one of them, or a topic under it, changes in
 * another tab or through any other writer, the query is invalidated. Changes the tab made itself
 * are skipped, since its own mutations already invalidate what they change.
 *
 * A screen can also hold its queries with `useLiveQueries`, so a change doesn't refetch them
 * under unsaved edits.
 */

import {
	matchQuery,
	useQueryClient,
	type Query,
	type QueryClient,
	type QueryKey,
} from "@tanstack/react-query";
import * as React from "react";

import { openLiveConnection } from "./connection.js";
import { TAB_ID } from "./tab-id.js";

/**
 * At most one round of invalidations this often. A co-edited entry saves every 2 to 10 seconds,
 * and each save would otherwise refetch every open list it appears in.
 */
const THROTTLE_MS = 2000;
/** Navigation swaps many queries at once; the topics are sent once it settles. */
const TOPICS_DELAY_MS = 100;

/** A change arrived, or the socket reopened after a gap in which one may have been missed. */
type Arrival = "change" | "gap";

interface LiveRegistration {
	/** Subscribed while registered, beyond the topics of queries' `meta.live`. */
	readonly topics: readonly string[];
	/** The queries a change to `topics` refetches, and that `held` keeps from refetching. */
	readonly queryKeys: readonly QueryKey[];
	/** Whether refetching the queries now would replace unsaved edits. */
	held(): boolean;
	/** Told instead of refetching while held. */
	arrived(arrival: Arrival): void;
}

interface LiveRegistry {
	readonly registrations: Set<LiveRegistration>;
	add(registration: LiveRegistration): () => void;
	onChange: (() => void) | null;
}

const LiveRegistryContext = React.createContext<LiveRegistry | null>(null);

export function LiveSyncProvider({
	enabled,
	children,
}: {
	/** Whether the host runs the realtime hub. */
	enabled: boolean;
	children: React.ReactNode;
}) {
	const queryClient = useQueryClient();
	const [registry] = React.useState(createRegistry);
	React.useEffect(
		() => (enabled ? startLiveSync(queryClient, registry) : undefined),
		[enabled, queryClient, registry],
	);
	return <LiveRegistryContext.Provider value={registry}>{children}</LiveRegistryContext.Provider>;
}

function createRegistry(): LiveRegistry {
	const registry: LiveRegistry = {
		registrations: new Set(),
		add(registration) {
			registry.registrations.add(registration);
			registry.onChange?.();
			return () => {
				registry.registrations.delete(registration);
				registry.onChange?.();
			};
		},
		onChange: null,
	};
	return registry;
}

/**
 * Keeps `queryKeys` from refetching under unsaved edits. While `dirty`, a live change to them, or
 * to `topics`, sets `changedElsewhere` instead; once the edits are saved or undone, the queries
 * catch up. `loadLatest` refetches them at once, for a notice's button. With `topics`, the tab
 * subscribes to them while mounted and a change refetches the queries when they aren't held.
 */
export function useLiveQueries({
	topics = NO_TOPICS,
	queryKeys,
	dirty,
}: {
	topics?: readonly string[];
	queryKeys: readonly QueryKey[];
	dirty: boolean;
}): { changedElsewhere: boolean; loadLatest(): Promise<void> } {
	const registry = React.useContext(LiveRegistryContext);
	const queryClient = useQueryClient();
	const [missed, setMissed] = React.useState<"none" | Arrival>("none");
	const dirtyRef = React.useRef(dirty);
	dirtyRef.current = dirty;
	const queryKeysRef = React.useRef(queryKeys);
	queryKeysRef.current = queryKeys;
	const topicsKey = topics.join("\n");

	React.useEffect(() => {
		if (!registry) return;
		return registry.add({
			topics: topicsKey ? topicsKey.split("\n") : NO_TOPICS,
			get queryKeys() {
				return queryKeysRef.current;
			},
			held: () => dirtyRef.current,
			arrived: (arrival) => setMissed((previous) => (previous === "change" ? previous : arrival)),
		});
	}, [registry, topicsKey]);

	const refetch = React.useCallback(
		() =>
			Promise.all(
				queryKeysRef.current.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			).then(() => undefined),
		[queryClient],
	);

	React.useEffect(() => {
		if (dirty || missed === "none") return;
		setMissed("none");
		void refetch();
	}, [dirty, missed, refetch]);

	const loadLatest = React.useCallback(() => {
		setMissed("none");
		return refetch();
	}, [refetch]);

	return { changedElsewhere: missed === "change", loadLatest };
}

const NO_TOPICS: readonly string[] = [];

function startLiveSync(queryClient: QueryClient, registry: LiveRegistry): () => void {
	const cache = queryClient.getQueryCache();
	const pendingQueries = new Map<string, Arrival>();
	const pendingRegistrations = new Map<LiveRegistration, Arrival>();
	let lastFlush = Number.NEGATIVE_INFINITY;
	let flushTimer: number | undefined;
	let topicsTimer: number | undefined;
	let sentTopics = "";

	const mark = (arrival: Arrival, matches: (topics: readonly string[]) => boolean) => {
		for (const query of cache.getAll()) {
			const topics = liveTopics(query);
			if (topics.length > 0 && matches(topics)) {
				pendingQueries.set(query.queryHash, merge(pendingQueries.get(query.queryHash), arrival));
			}
		}
		for (const registration of registry.registrations) {
			if (registration.topics.length > 0 && matches(registration.topics)) {
				pendingRegistrations.set(
					registration,
					merge(pendingRegistrations.get(registration), arrival),
				);
			}
		}
		if ((pendingQueries.size > 0 || pendingRegistrations.size > 0) && flushTimer === undefined) {
			flushTimer = window.setTimeout(flush, Math.max(0, lastFlush + THROTTLE_MS - Date.now()));
		}
	};

	const connection = openLiveConnection({
		changes(changes) {
			for (const change of changes) {
				if (change.origin === TAB_ID) continue;
				const reached = topicAndAncestors(change.topic);
				mark("change", (topics) => topics.some((topic) => reached.includes(topic)));
			}
		},
		resync() {
			mark("gap", () => true);
		},
	});

	function flush(): void {
		flushTimer = undefined;
		lastFlush = Date.now();
		const queries = new Map(pendingQueries);
		const registrations = new Map(pendingRegistrations);
		pendingQueries.clear();
		pendingRegistrations.clear();

		const held = [...registry.registrations].filter((registration) => registration.held());
		const told = new Map<LiveRegistration, Arrival>();
		const tell = (registration: LiveRegistration, arrival: Arrival) =>
			told.set(registration, merge(told.get(registration), arrival));
		for (const [hash, arrival] of queries) {
			const query = cache.get(hash);
			const holder = query && held.find((registration) => owns(registration, query));
			if (!holder) continue;
			queries.delete(hash);
			tell(holder, arrival);
		}
		const refetchKeys: QueryKey[] = [];
		for (const [registration, arrival] of registrations) {
			if (held.includes(registration)) tell(registration, arrival);
			else refetchKeys.push(...registration.queryKeys);
		}
		for (const [registration, arrival] of told) registration.arrived(arrival);

		if (queries.size === 0 && refetchKeys.length === 0) return;
		void queryClient.invalidateQueries({
			predicate: (query) =>
				queries.has(query.queryHash) ||
				refetchKeys.some((queryKey) => matchQuery({ queryKey }, query)),
			// A hidden tab marks them stale, and refetches them when it shows again.
			refetchType: document.visibilityState === "hidden" ? "none" : "active",
		});
	}

	function sendTopics(): void {
		topicsTimer = undefined;
		const topics = new Set<string>();
		for (const query of cache.getAll()) {
			if (query.getObserversCount() === 0) continue;
			for (const topic of liveTopics(query)) topics.add(topic);
		}
		for (const registration of registry.registrations) {
			for (const topic of registration.topics) topics.add(topic);
		}
		const sorted = [...topics].toSorted();
		const key = sorted.join("\n");
		if (key === sentTopics) return;
		sentTopics = key;
		connection.setTopics(sorted);
	}

	const scheduleTopics = () => {
		topicsTimer ??= window.setTimeout(sendTopics, TOPICS_DELAY_MS);
	};
	const unsubscribe = cache.subscribe((event) => {
		if (event.type === "observerAdded" || event.type === "observerRemoved") scheduleTopics();
	});
	registry.onChange = scheduleTopics;
	sendTopics();

	return () => {
		unsubscribe();
		registry.onChange = null;
		window.clearTimeout(flushTimer);
		window.clearTimeout(topicsTimer);
		connection.close();
	};
}

function owns(registration: LiveRegistration, query: Query): boolean {
	return registration.queryKeys.some((queryKey) => matchQuery({ queryKey }, query));
}

/** A change outweighs a gap: the screen should say something changed. */
function merge(previous: Arrival | undefined, next: Arrival): Arrival {
	return previous === "change" ? previous : next;
}

function liveTopics(query: Query): readonly string[] {
	const live = query.meta?.live;
	return Array.isArray(live)
		? live.filter((topic): topic is string => typeof topic === "string")
		: [];
}

/** `content/posts/01A` reaches `content/posts/01A`, `content/posts` and `content`. */
function topicAndAncestors(topic: string): string[] {
	const segments = topic.split("/");
	return segments.map((_, index) => segments.slice(0, segments.length - index).join("/"));
}
