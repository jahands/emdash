import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { runConcurrently } from "../../../src/database/concurrent.js";

function fakeDb(isTransaction: boolean): Kysely<unknown> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- runConcurrently reads only isTransaction
	return { isTransaction } as Kysely<unknown>;
}

describe("runConcurrently", () => {
	it("does not reject until every task has settled", async () => {
		let slowFinished = false;
		const run = runConcurrently(fakeDb(false), [
			async () => {
				throw new Error("fast failure");
			},
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				slowFinished = true;
			},
		]);

		await expect(run).rejects.toThrow("fast failure");
		expect(slowFinished).toBe(true);
	});

	it("starts tasks one after another inside a transaction", async () => {
		const events: string[] = [];
		const task = (name: string) => async () => {
			events.push(`${name}:start`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			events.push(`${name}:end`);
			return name;
		};

		const results = await runConcurrently(fakeDb(true), [task("a"), task("b")]);

		expect(results).toEqual(["a", "b"]);
		expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
	});
});
