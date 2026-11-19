import { AsyncLocalStorage } from "node:async_hooks";

import { createRealtimeAccess, normalizePluginCapabilities } from "emdash";
import type { PluginManifest, RealtimeAccess } from "emdash";

/**
 * `ctx.realtime` for sandboxed plugins on Node.js. Bridge calls arrive on the backing service's own
 * HTTP request, so each hook or route invocation opens its publishing in the request it runs for,
 * and the bridge finds it by the invocation's ID.
 */
export class RealtimeInvocations {
	readonly #open = new Map<string, RealtimeAccess>();

	/** Opens publishing for one invocation. The returned function closes it. */
	open(manifest: PluginManifest, invocationId: string): () => void {
		const capabilities = normalizePluginCapabilities(manifest.capabilities ?? []);
		if (!capabilities.includes("realtime:publish")) return () => {};
		const key = `${manifest.id}\n${invocationId}`;
		const run = AsyncLocalStorage.snapshot();
		this.#open.set(
			key,
			createRealtimeAccess(manifest.id, manifest.realtime?.channels, (publish) => run(publish)),
		);
		return () => this.#open.delete(key);
	}

	get(pluginId: string, invocationId: string): RealtimeAccess | undefined {
		return this.#open.get(`${pluginId}\n${invocationId}`);
	}
}
