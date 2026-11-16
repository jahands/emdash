/**
 * Realtime topics: `/`-separated paths naming what changed, such as `content/posts/01J…`. A change
 * reaches subscribers of its topic and of each ancestor that is itself a topic, so a change to an
 * entry reaches its collection's list. Shared code may import this module, so it stays free of
 * database and engine code.
 */

import { hasPermission, type Permission, type RoleLevel } from "@emdash-cms/auth";

interface Namespace {
	/** Needed to subscribe: the permission the namespace's list route checks. */
	permission: Permission;
	/** Segments after the namespace's own. */
	minKeys: number;
	maxKeys: number;
}

const NAMESPACES: Record<string, Namespace> = {
	content: { permission: "content:read_drafts", minKeys: 1, maxKeys: 2 },
	media: { permission: "media:read", minKeys: 0, maxKeys: 1 },
	comments: { permission: "comments:moderate", minKeys: 0, maxKeys: 0 },
	menus: { permission: "menus:read", minKeys: 0, maxKeys: 1 },
	widgets: { permission: "widgets:read", minKeys: 0, maxKeys: 1 },
	taxonomies: { permission: "taxonomies:read", minKeys: 0, maxKeys: 1 },
	settings: { permission: "settings:read", minKeys: 0, maxKeys: 0 },
	schema: { permission: "schema:read", minKeys: 0, maxKeys: 0 },
	users: { permission: "users:read", minKeys: 0, maxKeys: 1 },
	redirects: { permission: "redirects:read", minKeys: 0, maxKeys: 0 },
	bylines: { permission: "bylines:read", minKeys: 0, maxKeys: 0 },
	sections: { permission: "sections:read", minKeys: 0, maxKeys: 0 },
	plugins: { permission: "plugins:read", minKeys: 0, maxKeys: 0 },
};

const MAX_SEGMENT_LENGTH = 128;
const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;
// oxlint-disable-next-line no-control-regex -- refuses control characters in keys
const SEGMENT_CHARS = /^[^\s/\u0000-\u001f\u007f]+$/;

export interface Topic {
	namespace: string;
	keys: string[];
}

/** The topic a string names, or null when it isn't one. */
export function parseTopic(topic: string): Topic | null {
	if (typeof topic !== "string") return null;
	const [namespace = "", ...keys] = topic.split("/");
	const definition = Object.hasOwn(NAMESPACES, namespace) ? NAMESPACES[namespace] : undefined;
	if (!definition) return null;
	if (keys.length < definition.minKeys || keys.length > definition.maxKeys) return null;
	for (const key of keys) {
		if (key.length > MAX_SEGMENT_LENGTH || !SEGMENT_CHARS.test(key)) return null;
	}
	if (namespace === "content" && !COLLECTION_SLUG.test(keys[0] ?? "")) return null;
	return { namespace, keys };
}

/** Whether a user with `role` may subscribe to the topic. False for a string that isn't one. */
export function maySubscribe(role: RoleLevel, topic: string): boolean {
	const parsed = parseTopic(topic);
	if (!parsed) return false;
	return hasPermission({ role }, NAMESPACES[parsed.namespace].permission);
}

/** The topic and each of its ancestors that is a topic, nearest first. */
export function topicAndAncestors(topic: string): string[] {
	const parsed = parseTopic(topic);
	if (!parsed) return [];
	const definition = NAMESPACES[parsed.namespace];
	const topics: string[] = [];
	for (let keys = parsed.keys.length; keys >= definition.minKeys; keys--) {
		topics.push([parsed.namespace, ...parsed.keys.slice(0, keys)].join("/"));
	}
	return topics;
}

/** `content/{collection}`, or `content/{collection}/{id}` with an ID. */
export function contentTopic(collection: string, id?: string): string {
	return id === undefined ? `content/${collection}` : `content/${collection}/${id}`;
}
