import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxedPluginPage } from "../../src/components/SandboxedPluginPage";
import { SandboxedPluginWidget } from "../../src/components/SandboxedPluginWidget";
import { LiveSyncProvider, useLiveTopic } from "../../src/lib/realtime/LiveSyncProvider";
import { pluginTopic } from "../../src/lib/realtime/plugin-topic";
import { TAB_ID } from "../../src/lib/realtime/tab-id";
import { FakeSocket, openHub, settle, ticketResponse } from "../utils/fake-hub";
import { render } from "../utils/render";

const reads = { submissions: 0, pageLoads: [] as string[] };

beforeEach(() => {
	FakeSocket.instances = [];
	reads.submissions = 0;
	reads.pageLoads = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith("/_emdash/api/realtime") && init?.method === "POST") return ticketResponse();
		if (url.endsWith("/_emdash/api/plugins/forms/submissions")) {
			reads.submissions++;
			return Response.json({ data: [] });
		}
		if (url.endsWith("/_emdash/api/plugins/forms/admin")) {
			const interaction = JSON.parse(init?.body as string) as { type: string; page: string };
			if (interaction.type === "page_load") reads.pageLoads.push(interaction.page);
			return Response.json({ data: { blocks: [{ type: "header", text: "Queue" }] } });
		}
		return new Response(null, { status: 404 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function live(children: React.ReactNode) {
	return render(<LiveSyncProvider enabled>{children}</LiveSyncProvider>);
}

describe("useLiveTopic", () => {
	function Counter({ onChange }: { onChange: () => void }) {
		useLiveTopic(pluginTopic("forms", "submissions"), onChange);
		return null;
	}

	it("calls back when the plugin's channel or something in it changes elsewhere", async () => {
		const onChange = vi.fn();
		const screen = await live(<Counter onChange={onChange} />);
		const socket = await openHub(["plugin/forms/submissions"]);

		socket.change("plugin/forms/submissions", { origin: TAB_ID });
		socket.change("plugin/forms/audit");
		await settle();
		expect(onChange).not.toHaveBeenCalled();

		socket.change("plugin/forms/submissions/42", { op: "create" });
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

		await screen.rerender(<LiveSyncProvider enabled>{null}</LiveSyncProvider>);
		await vi.waitFor(() => expect(socket.topics()).toEqual([]));
	});
});

describe("a plugin query with meta.live", () => {
	function Submissions() {
		useQuery({
			queryKey: ["@acme/forms", "submissions"],
			queryFn: async () => {
				const response = await fetch("/_emdash/api/plugins/forms/submissions");
				return response.json();
			},
			meta: { live: [pluginTopic("@acme/forms", "submissions")] },
		});
		return null;
	}

	it("refetches when its channel changes", async () => {
		await live(<Submissions />);
		const socket = await openHub(["plugin/%40acme%2Fforms/submissions"]);
		await vi.waitFor(() => expect(reads.submissions).toBe(1));

		socket.change("plugin/%40acme%2Fforms/submissions/42");

		await vi.waitFor(() => expect(reads.submissions).toBe(2));
	});
});

describe("refreshOn", () => {
	it("loads a Block Kit widget again when one of its channels changes", async () => {
		const screen = await live(
			<SandboxedPluginWidget pluginId="forms" widgetId="queue" refreshOn={["queue"]} />,
		);
		const socket = await openHub(["plugin/forms/queue"]);
		await expect.element(screen.getByText("Queue")).toBeVisible();
		expect(reads.pageLoads).toEqual(["widget:queue"]);

		socket.change("plugin/forms/other");
		await settle();
		expect(reads.pageLoads).toEqual(["widget:queue"]);

		socket.change("plugin/forms/queue", { op: "update" });
		await vi.waitFor(() => expect(reads.pageLoads).toEqual(["widget:queue", "widget:queue"]));
		await expect.element(screen.getByText("Queue")).toBeVisible();
	});

	it("loads a Block Kit page again when one of its channels changes", async () => {
		await live(<SandboxedPluginPage pluginId="forms" page="/queue" refreshOn={["queue"]} />);
		const socket = await openHub(["plugin/forms/queue"]);
		await vi.waitFor(() => expect(reads.pageLoads).toEqual(["/queue"]));

		socket.change("plugin/forms/queue/7");

		await vi.waitFor(() => expect(reads.pageLoads).toEqual(["/queue", "/queue"]));
	});

	it("subscribes a surface without refreshOn to nothing", async () => {
		await live(<SandboxedPluginWidget pluginId="forms" widgetId="queue" />);
		await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
		const socket = FakeSocket.instances[0]!;
		socket.open();
		await vi.waitFor(() => expect(reads.pageLoads).toEqual(["widget:queue"]));

		socket.change("plugin/forms/queue");
		await settle();

		expect(socket.topics()).toEqual([]);
		expect(reads.pageLoads).toEqual(["widget:queue"]);
	});
});
