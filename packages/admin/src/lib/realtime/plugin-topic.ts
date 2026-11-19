/**
 * The topic of a plugin's realtime channel, for `useLiveTopic`, `usePresence` or a query's
 * `meta.live`: `plugin/{plugin}/{channel}`, or with a key, the topic of one thing in the channel.
 * The plugin ID is URI-encoded, since a scoped ID holds a `/`.
 */
export function pluginTopic(pluginId: string, channel: string, key?: string): string {
	const topic = `plugin/${encodeURIComponent(pluginId)}/${channel}`;
	return key === undefined ? topic : `${topic}/${key}`;
}
