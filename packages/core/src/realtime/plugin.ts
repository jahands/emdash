/**
 * `ctx.realtime` for plugins: publishing to the plugin's own declared channels, which the host
 * turns into `plugin/{plugin}/{channel}` topics. Shared by native plugins and the sandbox bridges,
 * which call it on the trusted side with a plugin's untrusted arguments.
 */

import { publishChange, type ChangeOp } from "./publish.js";
import { parseTopic, pluginTopic } from "./topics.js";

/** Publishes one invocation of a plugin may make. Past this, publishes are dropped. */
export const MAX_PLUGIN_PUBLISHES = 20;
const MAX_ID_LENGTH = 128;
const OPS: ReadonlySet<string> = new Set<ChangeOp>(["create", "update", "delete"]);

/** What changed in a channel. Like core changes, it carries no data. */
export interface PluginChange {
	/** The rows that changed. Absent when the whole channel may have changed. */
	ids?: string[];
	op?: ChangeOp;
}

export interface RealtimeAccess {
	/**
	 * Tells admin tabs that `channel` changed, so they refetch. `channel` is a name the plugin
	 * declares in `realtime.channels`, or `{name}/{key}` for one thing in it. Inside a database
	 * transaction it waits for the commit. Does nothing where the site runs no realtime hub.
	 */
	publish(channel: string, change?: PluginChange): Promise<void>;
}

/** The channels a plugin declares, each with the permission a user needs to receive it. */
export type PluginRealtimeChannels = Record<string, { permission: string }>;

/**
 * Publishing for one invocation of `pluginId`. `run` enters the request the invocation belongs to,
 * for a bridge whose calls arrive outside it, so changes wait in that request's transaction.
 */
export function createRealtimeAccess(
	pluginId: string,
	channels: PluginRealtimeChannels | undefined,
	run: (publish: () => void) => void = (publish) => publish(),
): RealtimeAccess {
	let published = 0;
	return {
		async publish(channel, change) {
			const topic = channelTopic(pluginId, channels ?? {}, channel);
			const checked = readChange(change);
			if (published >= MAX_PLUGIN_PUBLISHES) {
				if (published === MAX_PLUGIN_PUBLISHES) {
					console.warn(
						`[realtime] plugin "${pluginId}" published more than ${MAX_PLUGIN_PUBLISHES} changes in one invocation; dropping the rest`,
					);
				}
				published++;
				return;
			}
			published++;
			run(() => publishChange(topic, checked));
		},
	};
}

function channelTopic(
	pluginId: string,
	channels: PluginRealtimeChannels,
	channel: unknown,
): string {
	if (typeof channel !== "string") throw new TypeError("A realtime channel must be a string");
	const slash = channel.indexOf("/");
	const name = slash === -1 ? channel : channel.slice(0, slash);
	const key = slash === -1 ? undefined : channel.slice(slash + 1);
	if (!Object.hasOwn(channels, name)) {
		throw new Error(
			`Plugin "${pluginId}" has no realtime channel "${name}". Declare it in realtime.channels.`,
		);
	}
	const topic = pluginTopic(pluginId, name, key);
	if (!parseTopic(topic)) throw new Error(`Invalid realtime channel "${channel}"`);
	return topic;
}

function readChange(change: unknown): PluginChange {
	if (change === undefined || change === null) return {};
	if (typeof change !== "object") throw new TypeError("A realtime change must be an object");
	const checked: PluginChange = {};
	const ids = "ids" in change ? change.ids : undefined;
	if (ids !== undefined) {
		if (
			!Array.isArray(ids) ||
			!ids.every(
				(id): id is string => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH,
			)
		) {
			throw new TypeError(
				`A realtime change's ids must be strings of 1 to ${MAX_ID_LENGTH} characters`,
			);
		}
		checked.ids = ids;
	}
	const op = "op" in change ? change.op : undefined;
	if (op !== undefined) {
		if (typeof op !== "string" || !OPS.has(op)) {
			throw new TypeError('A realtime change\'s op must be "create", "update" or "delete"');
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked against OPS
		checked.op = op as ChangeOp;
	}
	return checked;
}
