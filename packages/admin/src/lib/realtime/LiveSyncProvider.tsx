/**
 * Live queries. A query opts in with `meta: { live: ["content/posts"] }`: while it has observers
 * the tab subscribes to those topics, and when one of them, or a topic under it, changes in
 * another tab or through any other writer, the query is invalidated. Changes the tab made itself
 * are skipped, since its own mutations already invalidate what they change.
 *
 * A screen can also hold its queries with `useLiveQueries`, so a change doesn't refetch them
 * under unsaved edits. `useAnnouncePresence` tells the hub where the tab is, and `usePresence`
 * reads who else is at a topic or under it.
 */

import {
	hashKey,
	matchQuery,
	useQueryClient,
	type Query,
	type QueryClient,
	type QueryKey,
} from "@tanstack/react-query";
import * as React from "react";

import { useCurrentUser } from "../api/current-user.js";
import { assignAuthorColors, authorColorOf, type AuthorColor } from "../author-colors.js";
import { openLiveConnection, type LivePlace, type PresenceActivity } from "./connection.js";
import { PresenceStore, type PresenceAt } from "./presence.js";
import { TAB_ID } from "./tab-id.js";

/** A query, or a screen's registration, refetches for live changes at most this often. */
const THROTTLE_MS = 2000;
/**
 * The same, for a query reached only by updates to entries under its topic. A co-edited entry
 * checkpoints every 2 to 10 seconds, and each checkpoint would otherwise refetch every open list
 * it appears in.
 */
const ENTRY_UPDATE_THROTTLE_MS = 15_000;
/** A timer can fire a little before the time it was set for. */
const TIMER_SLACK_MS = 10;
/** Navigation swaps many queries at once; the topics are sent once it settles. */
const TOPICS_DELAY_MS = 100;

/** A change arrived, or the socket reopened after a gap in which one may have been missed. */
type Arrival = "change" | "gap";

interface Pending {
	arrival: Arrival;
	/** Data from a fetch that started after this, in ms, already has the change. */
	since: number;
	/** How long after its last live refetch the query, or registration, may refetch again. */
	throttle: number;
}

interface LiveRegistration {
	/** Subscribed while registered, beyond the topics of queries' `meta.live`. */
	readonly topics: readonly string[];
	/** The queries a change to `topics` refetches, and that `held` keeps from refetching. */
	readonly queryKeys: readonly QueryKey[];
	/** Whether refetching the queries now would replace unsaved edits. */
	held(): boolean;
	/** Told instead of refetching while held. `since` is as in {@link Pending}. */
	arrived(arrival: Arrival, since: number): void;
}

interface LiveRegistry {
	readonly registrations: Set<LiveRegistration>;
	add(registration: LiveRegistration): () => void;
	onChange: (() => void) | null;
	/** Told when a registration goes, so nothing queued for it runs after. */
	onRemove: ((registration: LiveRegistration) => void) | null;
	/** Queues the changes a registration was told about while held, once it no longer is. */
	onCatchUp: ((registration: LiveRegistration, arrival: Arrival, since: number) => void) | null;
	/** Where mounted screens say the tab is. The last one mounted wins. */
	readonly places: LivePlace[];
	announce(place: LivePlace): () => void;
	onPlace: (() => void) | null;
	readonly presence: PresenceStore;
}

const LiveRegistryContext = React.createContext<LiveRegistry | null>(null);
/** Whether the host runs the hub, so screens can keep room for who is here. */
const LiveEnabledContext = React.createContext(false);

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
	return (
		<LiveEnabledContext.Provider value={enabled}>
			<LiveRegistryContext.Provider value={registry}>{children}</LiveRegistryContext.Provider>
		</LiveEnabledContext.Provider>
	);
}

function createRegistry(): LiveRegistry {
	const registry: LiveRegistry = {
		registrations: new Set(),
		add(registration) {
			registry.registrations.add(registration);
			registry.onChange?.();
			return () => {
				registry.registrations.delete(registration);
				registry.onRemove?.(registration);
				registry.onChange?.();
			};
		},
		onChange: null,
		onRemove: null,
		onCatchUp: null,
		places: [],
		announce(place) {
			registry.places.push(place);
			registry.onPlace?.();
			return () => {
				registry.places.splice(registry.places.indexOf(place), 1);
				registry.onPlace?.();
			};
		},
		onPlace: null,
		presence: new PresenceStore(),
	};
	return registry;
}

/** Whether the tab gets live updates and presence from the hub. */
export function useLiveEnabled(): boolean {
	return React.useContext(LiveEnabledContext);
}

/**
 * Calls `onChange` when one of `topics`, or a topic under it, changes in another tab or through any
 * other writer, and after a reconnect that may have missed a change. Subscribes the tab to `topics`
 * while mounted. Calls are throttled with the tab's other live refetches.
 */
export function useLiveTopic(topics: string | readonly string[], onChange: () => void): void {
	const registry = React.useContext(LiveRegistryContext);
	const onChangeRef = React.useRef(onChange);
	onChangeRef.current = onChange;
	const topicsKey = (typeof topics === "string" ? [topics] : topics).join("\n");
	React.useEffect(() => {
		if (!registry || !topicsKey) return;
		return registry.add({
			topics: topicsKey.split("\n"),
			queryKeys: NO_QUERY_KEYS,
			// Held with no queries, so the provider reports each change instead of refetching.
			held: () => true,
			arrived: () => onChangeRef.current(),
		});
	}, [registry, topicsKey]);
}

/** Tells others the tab is at `topic` while mounted. Null announces nothing. */
export function useAnnouncePresence(topic: string | null, activity: PresenceActivity): void {
	const registry = React.useContext(LiveRegistryContext);
	React.useEffect(() => {
		if (!registry || topic === null) return;
		return registry.announce({ topic, activity });
	}, [registry, topic, activity]);
}

/** Someone else at a place: other users only, once each per place, editing over viewing. */
export interface PresentPerson {
	readonly id: string;
	readonly name: string;
	readonly color: AuthorColor;
	readonly activity: PresenceActivity;
	/** Where they are: the topic asked about, or one under it. */
	readonly topic: string;
}

const NO_PEOPLE: readonly PresentPerson[] = Object.freeze([]);

/** Who else is at `topic` or under it. Subscribes the tab to `topic` while mounted. */
export function usePresence(topic: string | null): readonly PresentPerson[] {
	const registry = React.useContext(LiveRegistryContext);
	const self = useCurrentUser().data?.id ?? null;
	React.useEffect(() => {
		if (!registry || topic === null) return;
		return registry.add({
			topics: [topic],
			queryKeys: NO_QUERY_KEYS,
			held: () => false,
			arrived: () => {},
		});
	}, [registry, topic]);
	const tabs = React.useSyncExternalStore(
		registry?.presence.subscribe ?? subscribeToNothing,
		registry?.presence.snapshot ?? noTabs,
	);
	return React.useMemo(
		() => (topic === null ? NO_PEOPLE : peopleAt(tabs, topic, self)),
		[tabs, topic, self],
	);
}

const NO_QUERY_KEYS: readonly QueryKey[] = [];
const subscribeToNothing = () => () => {};
const NO_TABS: readonly PresenceAt[] = Object.freeze([]);
const noTabs = () => NO_TABS;

function peopleAt(
	tabs: readonly PresenceAt[],
	topic: string,
	self: string | null,
): readonly PresentPerson[] {
	const prefix = `${topic}/`;
	const found = new Map<string, PresenceAt>();
	for (const tab of tabs) {
		if (tab.topic !== topic && !tab.topic.startsWith(prefix)) continue;
		if (tab.clientId === TAB_ID || tab.userId === self) continue;
		const key = `${tab.topic}\n${tab.userId}`;
		const known = found.get(key);
		if (!known || (known.activity === "viewing" && tab.activity === "editing")) found.set(key, tab);
	}
	if (found.size === 0) return NO_PEOPLE;
	const colors = assignAuthorColors([self, ...Array.from(found.values(), (tab) => tab.userId)]);
	return Array.from(found.values(), (tab) => ({
		id: tab.userId,
		name: tab.name,
		color: authorColorOf(colors, tab.userId),
		activity: tab.activity,
		topic: tab.topic,
	}));
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
	/** When the latest change held back arrived, as in {@link Pending}. */
	const missedSinceRef = React.useRef(Number.NEGATIVE_INFINITY);
	const registrationRef = React.useRef<LiveRegistration | null>(null);
	const dirtyRef = React.useRef(dirty);
	dirtyRef.current = dirty;
	const queryKeysRef = React.useRef(queryKeys);
	queryKeysRef.current = queryKeys;
	const topicsKey = topics.join("\n");
	const queryKeysKey = hashKey(queryKeys);

	// Registered again for other queries, such as another entry's, so a change to the previous ones
	// never reaches these.
	React.useEffect(() => {
		if (!registry) return;
		setMissed("none");
		missedSinceRef.current = Number.NEGATIVE_INFINITY;
		const registration: LiveRegistration = {
			topics: topicsKey ? topicsKey.split("\n") : NO_TOPICS,
			queryKeys: queryKeysRef.current,
			held: () => dirtyRef.current,
			arrived: (arrival, since) => {
				missedSinceRef.current = Math.max(missedSinceRef.current, since);
				setMissed((previous) => (previous === "change" ? previous : arrival));
			},
		};
		registrationRef.current = registration;
		const remove = registry.add(registration);
		return () => {
			if (registrationRef.current === registration) registrationRef.current = null;
			remove();
		};
	}, [registry, topicsKey, queryKeysKey]);

	const refetch = React.useCallback(
		() =>
			Promise.all(
				queryKeysRef.current.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			).then(() => undefined),
		[queryClient],
	);

	// Through the shared queue, so a read that started after the change, such as the save's own,
	// already covers it.
	React.useEffect(() => {
		if (dirty || missed === "none") return;
		setMissed("none");
		const registration = registrationRef.current;
		if (registry?.onCatchUp && registration) {
			registry.onCatchUp(registration, missed, missedSinceRef.current);
		} else {
			void refetch();
		}
		missedSinceRef.current = Number.NEGATIVE_INFINITY;
	}, [dirty, missed, refetch, registry]);

	const loadLatest = React.useCallback(() => {
		setMissed("none");
		return refetch();
	}, [refetch]);

	return { changedElsewhere: missed === "change", loadLatest };
}

const NO_TOPICS: readonly string[] = [];

function startLiveSync(queryClient: QueryClient, registry: LiveRegistry): () => void {
	const cache = queryClient.getQueryCache();
	const pendingQueries = new Map<string, Pending>();
	const pendingRegistrations = new Map<LiveRegistration, Pending>();
	/** Queries a change reached mid-fetch, queued again once that fetch settles. */
	const trailing = new Map<string, Pending>();
	/** When each query's current fetch started, and when the fetch that gave its data did. */
	const fetchStarted = new Map<string, number>();
	const dataFetchStarted = new Map<string, number>();
	/** When each registration last refetched or was told for a live change. */
	const lastRun = new Map<LiveRegistration, number>();
	let flushTimer: number | undefined;
	let flushAt = Number.POSITIVE_INFINITY;
	let topicsTimer: number | undefined;
	let placeTimer: number | undefined;
	let sentTopics = "";

	/** `throttleFor` gives the throttle for topics the change reaches, or undefined for none. */
	const mark = (
		change: Omit<Pending, "throttle">,
		throttleFor: (topics: readonly string[]) => number | undefined,
	) => {
		for (const query of cache.getAll()) {
			const topics = liveTopics(query);
			const throttle = topics.length > 0 ? throttleFor(topics) : undefined;
			if (throttle !== undefined) {
				pendingQueries.set(
					query.queryHash,
					mergePending(pendingQueries.get(query.queryHash), { ...change, throttle }),
				);
			}
		}
		for (const registration of registry.registrations) {
			const throttle =
				registration.topics.length > 0 ? throttleFor(registration.topics) : undefined;
			if (throttle !== undefined) {
				pendingRegistrations.set(
					registration,
					mergePending(pendingRegistrations.get(registration), { ...change, throttle }),
				);
			}
		}
		schedule();
	};

	const dueAt = (key: string | LiveRegistration, pending: Pending) =>
		// A query's window runs from when its last fetch actually started, whatever started it.
		((typeof key === "string" ? fetchStarted.get(key) : lastRun.get(key)) ??
			Number.NEGATIVE_INFINITY) + pending.throttle;

	function schedule(): void {
		let due = Number.POSITIVE_INFINITY;
		for (const [hash, pending] of pendingQueries) due = Math.min(due, dueAt(hash, pending));
		for (const [registration, pending] of pendingRegistrations) {
			due = Math.min(due, dueAt(registration, pending));
		}
		if (due === Number.POSITIVE_INFINITY || (flushTimer !== undefined && flushAt <= due)) return;
		window.clearTimeout(flushTimer);
		flushAt = due;
		flushTimer = window.setTimeout(flush, Math.max(0, due - Date.now()));
	}

	const connection = openLiveConnection({
		changes(changes) {
			for (const change of changes) {
				if (change.origin === TAB_ID) continue;
				const reached = topicAndAncestors(change.topic);
				const bubbled = isEntryUpdate(change) ? ENTRY_UPDATE_THROTTLE_MS : THROTTLE_MS;
				mark({ arrival: "change", since: Date.now() }, (topics) => {
					if (topics.includes(change.topic)) return THROTTLE_MS;
					return topics.some((topic) => reached.includes(topic)) ? bubbled : undefined;
				});
			}
		},
		resync(since) {
			mark({ arrival: "gap", since }, () => THROTTLE_MS);
		},
		presence(places, all) {
			registry.presence.apply(places, all);
		},
	});

	function takeDue<K extends string | LiveRegistration>(
		pending: Map<K, Pending>,
		now: number,
	): Map<K, Pending> {
		const due = new Map<K, Pending>();
		for (const [key, value] of pending) {
			if (dueAt(key, value) > now + TIMER_SLACK_MS) continue;
			pending.delete(key);
			due.set(key, value);
			if (typeof key !== "string") lastRun.set(key, now);
		}
		return due;
	}

	function flush(): void {
		flushTimer = undefined;
		flushAt = Number.POSITIVE_INFINITY;
		const startedAt = Date.now();
		for (const [key, ranAt] of lastRun) {
			if (ranAt + ENTRY_UPDATE_THROTTLE_MS < startedAt) lastRun.delete(key);
		}

		const held = [...registry.registrations].filter((registration) => registration.held());
		const told = new Map<LiveRegistration, Pending>();
		const tell = (registration: LiveRegistration, pending: Pending) =>
			told.set(registration, mergePending(told.get(registration), pending));
		// A registration's queries queue like any other query, so they share its throttle.
		for (const [registration, pending] of takeDue(pendingRegistrations, startedAt)) {
			if (held.includes(registration)) {
				tell(registration, pending);
				continue;
			}
			for (const query of cache.getAll()) {
				if (!owns(registration, query)) continue;
				pendingQueries.set(
					query.queryHash,
					mergePending(pendingQueries.get(query.queryHash), pending),
				);
			}
		}
		const queries = takeDue(pendingQueries, startedAt);
		schedule();

		for (const [hash, pending] of queries) {
			const query = cache.get(hash);
			const holder = query && held.find((registration) => owns(registration, query));
			if (!holder) continue;
			queries.delete(hash);
			tell(holder, pending);
		}
		for (const [registration, pending] of told)
			registration.arrived(pending.arrival, pending.since);

		const now = new Set<string>();
		for (const [hash, pending] of queries) {
			const query = cache.get(hash);
			if (!query) continue;
			if (query.state.fetchStatus === "fetching") {
				if ((fetchStarted.get(hash) ?? Number.NEGATIVE_INFINITY) > pending.since) continue;
				// List reads ignore the abort signal, so cancelling would only make the server do the
				// work again, and steady changes could keep a slow list from ever finishing.
				trailing.set(hash, mergePending(trailing.get(hash), pending));
			} else if ((dataFetchStarted.get(hash) ?? Number.NEGATIVE_INFINITY) <= pending.since) {
				now.add(hash);
			}
		}
		invalidate(now);
	}

	function invalidate(hashes: ReadonlySet<string>): void {
		if (hashes.size === 0) return;
		void queryClient.invalidateQueries(
			{
				predicate: (query) => hashes.has(query.queryHash),
				// A hidden tab marks them stale, and refetches them when it shows again.
				refetchType: document.visibilityState === "hidden" ? "none" : "active",
			},
			{ cancelRefetch: false },
		);
	}

	/** Queues a query that a change reached mid-fetch, now that the fetch settled. */
	function refetchTrailing(query: Query): void {
		const hash = query.queryHash;
		const pending = trailing.get(hash);
		if (!pending || query.state.fetchStatus !== "idle") return;
		trailing.delete(hash);
		pendingQueries.set(hash, mergePending(pendingQueries.get(hash), pending));
		schedule();
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
		else if (event.type === "removed") {
			trailing.delete(event.query.queryHash);
			fetchStarted.delete(event.query.queryHash);
			dataFetchStarted.delete(event.query.queryHash);
		} else if (event.type === "updated") {
			const hash = event.query.queryHash;
			// Loading another page leaves the pages already loaded as old as they were.
			if (event.action.type === "fetch" && !event.action.meta?.fetchMore) {
				fetchStarted.set(hash, Date.now());
			} else if (event.action.type === "success" && !event.action.manual) {
				dataFetchStarted.set(hash, fetchStarted.get(hash) ?? Number.NEGATIVE_INFINITY);
			}
			// Outside the cache's notification, which is still dispatching the settled fetch.
			if (trailing.has(hash)) queueMicrotask(() => refetchTrailing(event.query));
		}
	});
	registry.onChange = scheduleTopics;
	registry.onRemove = (registration) => {
		pendingRegistrations.delete(registration);
		lastRun.delete(registration);
	};
	registry.onCatchUp = (registration, arrival, since) => {
		pendingRegistrations.set(
			registration,
			mergePending(pendingRegistrations.get(registration), {
				arrival,
				since,
				throttle: THROTTLE_MS,
			}),
		);
		schedule();
	};
	sendTopics();

	// A screen that swaps its activity remounts its announcement; one frame goes out once it settles.
	const sendPlace = () => {
		placeTimer = undefined;
		connection.setPlace(registry.places.at(-1) ?? null);
	};
	registry.onPlace = () => {
		placeTimer ??= window.setTimeout(sendPlace, TOPICS_DELAY_MS);
	};
	sendPlace();

	return () => {
		unsubscribe();
		registry.onChange = null;
		registry.onRemove = null;
		registry.onCatchUp = null;
		registry.onPlace = null;
		window.clearTimeout(flushTimer);
		window.clearTimeout(topicsTimer);
		window.clearTimeout(placeTimer);
		connection.close();
		registry.presence.apply([], true);
	};
}

function owns(registration: LiveRegistration, query: Query): boolean {
	return registration.queryKeys.some((queryKey) => matchQuery({ queryKey }, query));
}

/** A change outweighs a gap: the screen should say something changed. */
function merge(previous: Arrival | undefined, next: Arrival): Arrival {
	return previous === "change" ? previous : next;
}

function mergePending(previous: Pending | undefined, next: Pending): Pending {
	if (!previous) return next;
	return {
		arrival: merge(previous.arrival, next.arrival),
		since: Math.max(previous.since, next.since),
		throttle: Math.min(previous.throttle, next.throttle),
	};
}

/** An update to one content entry, as a co-editing room's checkpoint publishes. */
function isEntryUpdate(change: { topic: string; op?: string }): boolean {
	return (
		change.op === "update" &&
		change.topic.startsWith("content/") &&
		change.topic.split("/").length === 3
	);
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
