import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommentRepository } from "../../../src/database/repositories/comment.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MenuRepository } from "../../../src/database/repositories/menu.js";
import { withTransaction } from "../../../src/database/transaction.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	setChangePublisher,
	withChangeOrigin,
	type Change,
} from "../../../src/realtime/publish.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { RecordingNotifier } from "../../utils/room-notifier.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = "user_editor";

/** A hub host that records each batch, with the transactions committed when it arrived. */
class RecordingPublisher {
	readonly batches: Array<{ changes: Change[]; commits: number }> = [];
	readonly commits = new RecordingNotifier();

	publish(changes: Change[]): Promise<void> {
		this.batches.push({ changes, commits: this.commits.commits });
		return Promise.resolve();
	}

	async take() {
		await waitForDeferredTasks();
		return this.batches.splice(0);
	}
}

describeEachDialect("Realtime change queue", (dialect) => {
	let ctx: DialectTestContext;
	let publisher: RecordingPublisher;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		publisher = new RecordingPublisher();
		setChangePublisher(publisher);
	});

	afterEach(async () => {
		setChangePublisher(null);
		await teardownForDialect(ctx);
	});

	async function createPost(): Promise<string> {
		const item = await new ContentRepository(ctx.db).create({
			type: "post",
			data: { title: "Hello" },
			slug: `entry-${crypto.randomUUID()}`,
		});
		await publisher.take();
		return item.id;
	}

	it("publishes a write outside any transaction at once", async () => {
		const id = await createPost();

		await withChangeOrigin("tab-1", () =>
			new ContentRepository(ctx.db).update("post", id, { data: { title: "Now" } }),
		);

		expect(await publisher.take()).toEqual([
			{
				changes: [{ topic: `content/post/${id}`, op: "update", origin: "tab-1" }],
				commits: 0,
			},
		]);
	});

	it("publishes one merged batch once the outermost transaction commits", async () => {
		const a = await createPost();
		const b = await createPost();
		const db = publisher.commits.observeCommits(ctx.db);

		await withTransaction(db, async (trx) => {
			await new ContentRepository(trx).update("post", a, { data: { title: "One" } });
			await withTransaction(trx, async (inner) => {
				const repo = new ContentRepository(inner);
				await repo.update("post", a, { data: { title: "Two" } });
				await repo.update("post", b, { data: { title: "Three" } });
			});
			await waitForDeferredTasks();
			expect(publisher.batches).toEqual([]);
		});

		expect(await publisher.take()).toEqual([
			{
				changes: [
					{ topic: `content/post/${a}`, op: "update" },
					{ topic: `content/post/${b}`, op: "update" },
				],
				commits: 1,
			},
		]);
	});

	it("publishes nothing when the transaction rolls back", async () => {
		const id = await createPost();

		await expect(
			withTransaction(ctx.db, async (trx) => {
				await new ContentRepository(trx).update("post", id, { data: { title: "Lost" } });
				throw new Error("Refused");
			}),
		).rejects.toThrow("Refused");

		expect(await publisher.take()).toEqual([]);
	});

	it("publishes a room's save to the entry's list", async () => {
		await ctx.db
			.insertInto("users")
			.values({
				id: EDITOR,
				email: "editor@example.com",
				name: "Editor",
				role: Role.EDITOR,
				email_verified: 1,
				disabled: 0,
			})
			.execute();
		const id = await createPost();
		const runtime = createTestRuntime(ctx.db);
		const site = createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime)));
		const loaded = await site.load({ collection: "post", id });

		const saved = await site.save(
			{ collection: "post", id },
			{
				actorId: EDITOR,
				rev: loaded!.rev,
				data: { title: "From the room" },
				kept: false,
				editedBy: [EDITOR],
			},
		);

		expect(saved).toMatchObject({ ok: true });
		const topics = (await publisher.take()).flatMap((batch) => batch.changes.map((c) => c.topic));
		expect(topics).toContain(`content/post/${id}`);
	});

	it("publishes comment moderation but not new comments", async () => {
		const repo = new CommentRepository(ctx.db);
		const comment = await repo.create({
			collection: "post",
			contentId: "entry-1",
			authorName: "Visitor",
			authorEmail: "visitor@example.com",
			body: "Hi",
			status: "pending",
		});
		expect(await publisher.take()).toEqual([]);

		await repo.bulkUpdateStatus([comment.id], "approved");

		expect(await publisher.take()).toEqual([
			{ changes: [{ topic: "comments", ids: [comment.id], op: "update" }], commits: 0 },
		]);
	});

	it("publishes menu item writes to the menus list with the menu's ID", async () => {
		const repo = new MenuRepository(ctx.db);
		const menu = await repo.create({ name: "main", label: "Main" });
		await publisher.take();

		await repo.createItem(menu.id, menu.locale, { type: "custom", label: "Home", customUrl: "/" });

		expect(await publisher.take()).toEqual([
			{ changes: [{ topic: "menus", ids: [menu.id], op: "update" }], commits: 0 },
		]);
	});

	describe("with no publisher", () => {
		beforeEach(() => setChangePublisher(null));

		it("publishes nothing", async () => {
			const id = await createPost();

			await new ContentRepository(ctx.db).update("post", id, { data: { title: "Now" } });

			expect(await publisher.take()).toEqual([]);
		});
	});
});
