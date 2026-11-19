import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("EmDashRuntime.getRealtimeChannels", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("lists each enabled plugin's channels with their permissions, by channel key", async () => {
		const forms = definePlugin({
			id: "@acme/forms",
			version: "1.0.0",
			capabilities: ["realtime:publish"],
			realtime: {
				channels: {
					submissions: { permission: "settings:read" },
					audit: { permission: "plugins:manage" },
				},
			},
		});
		const queue = definePlugin({
			id: "queue",
			version: "1.0.0",
			realtime: { channels: { jobs: { permission: "content:read_drafts" } } },
		});
		const runtime = createTestRuntime(db, {
			plugins: [forms, queue, definePlugin({ id: "quiet", version: "1.0.0" })],
		});

		expect(runtime.getRealtimeChannels()).toEqual({
			"%40acme%2Fforms/submissions": "settings:read",
			"%40acme%2Fforms/audit": "plugins:manage",
			"queue/jobs": "content:read_drafts",
		});

		await runtime.setPluginStatus("queue", "inactive");

		expect(runtime.getRealtimeChannels()).toEqual({
			"%40acme%2Fforms/submissions": "settings:read",
			"%40acme%2Fforms/audit": "plugins:manage",
		});
	});
});
