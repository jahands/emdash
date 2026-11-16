/**
 * Live queries. A query opts in with `meta: { live: ["content/posts"] }`: while it has observers
 * the tab subscribes to those topics, and when one of them, or a topic under it, changes in
 * another tab or through any other writer, the query is invalidated. Changes the tab made itself
 * are skipped, since its own mutations already invalidate what they change.
 */

import { useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
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

export function LiveSyncProvider({
	enabled,
	children,
}: {
	/** Whether the host runs the realtime hub. */
	enabled: boolean;
	children: React.ReactNode;
}) {
	const queryClient = useQueryClient();
	React.useEffect(() => (enabled ? startLiveSync(queryClient) : undefined), [enabled, queryClient]);
	return children;
}

function startLiveSync(queryClient: QueryClient): () => void {
	const cache = queryClient.getQueryCache();
	const pending = new Set<string>();
	let lastFlush = Number.NEGATIVE_INFINITY;
	let flushTimer: number | undefined;
	let topicsTimer: number | undefined;
	let sentTopics = "";

	const markLive = (matches: (topics: readonly string[]) => boolean) => {
		for (const query of cache.getAll()) {
			const topics = liveTopics(query);
			if (topics.length > 0 && matches(topics)) pending.add(query.queryHash);
		}
		if (pending.size > 0 && flushTimer === undefined) {
			flushTimer = window.setTimeout(flush, Math.max(0, lastFlush + THROTTLE_MS - Date.now()));
		}
	};

	const connection = openLiveConnection({
		changes(changes) {
			for (const change of changes) {
				if (change.origin === TAB_ID) continue;
				const reached = topicAndAncestors(change.topic);
				markLive((topics) => topics.some((topic) => reached.includes(topic)));
			}
		},
		resync() {
			markLive(() => true);
		},
	});

	function flush(): void {
		flushTimer = undefined;
		lastFlush = Date.now();
		const hashes = new Set(pending);
		pending.clear();
		void queryClient.invalidateQueries({
			predicate: (query) => hashes.has(query.queryHash),
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
		const sorted = [...topics].toSorted();
		const key = sorted.join("\n");
		if (key === sentTopics) return;
		sentTopics = key;
		connection.setTopics(sorted);
	}

	const unsubscribe = cache.subscribe((event) => {
		if (event.type === "observerAdded" || event.type === "observerRemoved") {
			topicsTimer ??= window.setTimeout(sendTopics, TOPICS_DELAY_MS);
		}
	});
	sendTopics();

	return () => {
		unsubscribe();
		window.clearTimeout(flushTimer);
		window.clearTimeout(topicsTimer);
		connection.close();
	};
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
