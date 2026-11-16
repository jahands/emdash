import type { PluginManifest } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../core/src/deferred-tasks.js";
import {
	setChangePublisher,
	withChangeQueue,
	type Change,
} from "../../core/src/realtime/publish.js";
import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";
import { RealtimeInvocations } from "../src/sandbox/realtime-invocations.js";

function manifest(capabilities: PluginManifest["capabilities"]): PluginManifest {
	return {
		id: "forms",
		version: "1.0.0",
		capabilities,
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
		realtime: { channels: { queue: { permission: "settings:read" } } },
	};
}

describe("realtime/publish through the Node.js bridge", () => {
	let published: Change[];
	let invocations: RealtimeInvocations;

	beforeEach(() => {
		published = [];
		invocations = new RealtimeInvocations();
		setChangePublisher({
			publish: async (changes) => {
				published.push(...changes);
			},
		});
	});

	afterEach(() => {
		setChangePublisher(null);
		vi.restoreAllMocks();
	});

	function handler(capabilities: string[], pluginId = "forms") {
		return createBridgeHandler({
			pluginId,
			version: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
			db: {} as never,
			emailSend: () => null,
			realtime: (invocationId) => invocations.get(pluginId, invocationId),
		});
	}

	async function publish(
		bridge: ReturnType<typeof handler>,
		body: Record<string, unknown>,
	): Promise<{ result?: unknown; error?: string }> {
		const response = await bridge(
			new Request("http://bridge/realtime/publish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		return response.json() as Promise<{ result?: unknown; error?: string }>;
	}

	it("holds a change in the transaction of the request its invocation runs for", async () => {
		const bridge = handler(["realtime:publish"]);
		let release!: () => void;
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => (opened = resolve));
		const running = withChangeQueue(async () => {
			const close = invocations.open(manifest(["realtime:publish"]), "inv-1");
			opened();
			await new Promise<void>((resolve) => (release = resolve));
			close();
		});
		await ready;

		// The bridge's request runs outside the invocation's async context.
		expect(
			await publish(bridge, {
				invocationId: "inv-1",
				channel: "queue/7",
				change: { op: "update" },
			}),
		).toEqual({
			result: null,
		});
		await waitForDeferredTasks();
		expect(published).toEqual([]);

		release();
		await running;
		await waitForDeferredTasks();
		expect(published).toEqual([{ topic: "plugin/forms/queue/7", op: "update" }]);
	});

	it("limits publishes per invocation", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const bridge = handler(["realtime:publish"]);
		const close = invocations.open(manifest(["realtime:publish"]), "inv-1");

		for (let index = 0; index < 22; index++) {
			expect(await publish(bridge, { invocationId: "inv-1", channel: "queue" })).toEqual({
				result: null,
			});
		}
		close();
		await waitForDeferredTasks();

		expect(published).toHaveLength(20);
	});

	it("refuses a publish without the capability, outside an invocation, or off its channels", async () => {
		const close = invocations.open(manifest(["realtime:publish"]), "inv-1");

		expect(
			(await publish(handler([]), { invocationId: "inv-1", channel: "queue" })).error,
		).toContain("Missing capability: realtime:publish");
		expect(
			(await publish(handler(["realtime:publish"]), { invocationId: "inv-2", channel: "queue" }))
				.error,
		).toContain("only available while a hook or route runs");
		expect(
			(
				await publish(handler(["realtime:publish"], "other"), {
					invocationId: "inv-1",
					channel: "queue",
				})
			).error,
		).toContain("only available while a hook or route runs");
		expect(
			(
				await publish(handler(["realtime:publish"]), {
					invocationId: "inv-1",
					channel: "../../content/posts",
				})
			).error,
		).toContain("no realtime channel");

		close();
		expect(
			(await publish(handler(["realtime:publish"]), { invocationId: "inv-1", channel: "queue" }))
				.error,
		).toContain("only available while a hook or route runs");
		await waitForDeferredTasks();
		expect(published).toEqual([]);
	});

	it("opens nothing for a plugin without the capability", () => {
		invocations.open(manifest([]), "inv-1");

		expect(invocations.get("forms", "inv-1")).toBeUndefined();
	});
});
