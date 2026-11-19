import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { createRealtimeAccess, MAX_PLUGIN_PUBLISHES } from "../../../src/realtime/plugin.js";
import {
	setChangePublisher,
	withChangeQueue,
	type Change,
	type ChangePublisher,
} from "../../../src/realtime/publish.js";

const CHANNELS = { submissions: { permission: "settings:read" } };

describe("createRealtimeAccess", () => {
	let published: Change[];
	const publisher: ChangePublisher = {
		publish(changes) {
			published.push(...changes);
			return Promise.resolve();
		},
	};

	async function take(): Promise<Change[]> {
		await waitForDeferredTasks();
		return published.splice(0);
	}

	beforeEach(() => {
		published = [];
		setChangePublisher(publisher);
	});

	afterEach(() => {
		setChangePublisher(null);
		vi.restoreAllMocks();
	});

	it("publishes a declared channel under the plugin's namespace", async () => {
		const realtime = createRealtimeAccess("@acme/forms", CHANNELS);

		await realtime.publish("submissions", { ids: ["42"], op: "create" });
		await realtime.publish("submissions/42");

		expect(await take()).toEqual([
			{ topic: "plugin/%40acme%2Fforms/submissions", ids: ["42"], op: "create" },
			{ topic: "plugin/%40acme%2Fforms/submissions/42" },
		]);
	});

	it.each([
		["an undeclared channel", "audit"],
		["a path out of its channel", "submissions/42/../../other"],
		["a core topic", "../../content/posts"],
		["another plugin's channel", "../other/submissions"],
		["an empty key", "submissions/"],
		["an inherited property", "__proto__"],
	])("refuses %s", async (_name, channel) => {
		const realtime = createRealtimeAccess("forms", CHANNELS);

		await expect(realtime.publish(channel)).rejects.toThrow();
		expect(await take()).toEqual([]);
	});

	it("refuses a change with a malformed op or IDs", async () => {
		const realtime = createRealtimeAccess("forms", CHANNELS);

		await expect(realtime.publish("submissions", { op: "drop" as never })).rejects.toThrow(/op/);
		await expect(realtime.publish("submissions", { ids: [42] as never })).rejects.toThrow(/ids/);
		await expect(realtime.publish("submissions", { ids: ["x".repeat(129)] })).rejects.toThrow(
			/ids/,
		);
		expect(await take()).toEqual([]);
	});

	it(`drops publishes past ${MAX_PLUGIN_PUBLISHES} in one invocation`, async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const invocation = createRealtimeAccess("forms", CHANNELS);

		for (let index = 0; index < MAX_PLUGIN_PUBLISHES + 5; index++) {
			await invocation.publish(`submissions/${index}`);
		}
		const next = createRealtimeAccess("forms", CHANNELS);
		await next.publish("submissions");

		const topics = (await take()).map((change) => change.topic);
		expect(topics).toHaveLength(MAX_PLUGIN_PUBLISHES + 1);
		expect(topics).not.toContain(`plugin/forms/submissions/${MAX_PLUGIN_PUBLISHES}`);
		expect(topics.at(-1)).toBe("plugin/forms/submissions");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("waits for the transaction around it, and publishes nothing if it throws", async () => {
		const realtime = createRealtimeAccess("forms", CHANNELS);

		await withChangeQueue(async () => {
			await realtime.publish("submissions", { op: "update" });
			await waitForDeferredTasks();
			expect(published).toEqual([]);
		});
		expect(await take()).toEqual([{ topic: "plugin/forms/submissions", op: "update" }]);

		await expect(
			withChangeQueue(async () => {
				await realtime.publish("submissions");
				throw new Error("rolled back");
			}),
		).rejects.toThrow("rolled back");
		expect(await take()).toEqual([]);
	});

	it("enters the request a bridge hands it", async () => {
		let entered = 0;
		const realtime = createRealtimeAccess("forms", CHANNELS, (publish) => {
			entered++;
			publish();
		});

		await realtime.publish("submissions");

		expect(entered).toBe(1);
		expect(await take()).toEqual([{ topic: "plugin/forms/submissions" }]);
	});

	it("does nothing where the site runs no hub", async () => {
		setChangePublisher(null);
		const realtime = createRealtimeAccess("forms", CHANNELS);

		await expect(realtime.publish("submissions")).resolves.toBeUndefined();
		await expect(realtime.publish("audit")).rejects.toThrow(/no realtime channel/);
	});
});
