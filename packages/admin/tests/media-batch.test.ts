import { expect, it, vi } from "vitest";

import { fetchMediaItem } from "../src/lib/api/media.js";

it("coalesces media reads and keeps missing items independent", async () => {
	const calls: string[] = [];
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		calls.push(input instanceof Request ? input.url : input.toString());
		return new Response(
			JSON.stringify({
				success: true,
				data: { items: [{ id: "a", contentHash: "latest" }, { id: "b" }] },
			}),
			{ headers: { "Content-Type": "application/json" } },
		);
	});
	try {
		const result = await Promise.allSettled([
			fetchMediaItem("a"),
			fetchMediaItem("b"),
			fetchMediaItem("gone"),
		]);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]!, location.origin).searchParams.get("ids")).toBe("a,b,gone");
		expect(result[0]).toEqual({ status: "fulfilled", value: { id: "a", contentHash: "latest" } });
		expect(result[1]?.status).toBe("fulfilled");
		expect(result[2]?.status).toBe("rejected");
	} finally {
		fetch.mockRestore();
	}
});

it("cancels one caller without canceling a shared media read", async () => {
	let finish!: (response: Response) => void;
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	try {
		const controller = new AbortController();
		const first = fetchMediaItem("a", { signal: controller.signal });
		const second = fetchMediaItem("b");
		const firstResult = Promise.allSettled([first]);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		controller.abort();
		expect((await firstResult)[0]?.status).toBe("rejected");
		finish(new Response(JSON.stringify({ data: { items: [{ id: "b", contentHash: "fresh" }] } })));
		await expect(second).resolves.toEqual({ id: "b", contentHash: "fresh" });
	} finally {
		fetch.mockRestore();
	}
});
