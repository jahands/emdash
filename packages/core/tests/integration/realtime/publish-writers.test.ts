import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleBylineFieldCreate } from "../../../src/api/handlers/byline-fields.js";
import {
	handleSchemaCollectionCreate,
	handleSchemaFieldCreate,
} from "../../../src/api/handlers/schema.js";
import {
	handleSectionCreate,
	handleSectionDelete,
	handleSectionUpdate,
} from "../../../src/api/handlers/sections.js";
import {
	handleTaxonomyCreate,
	handleTermCreate,
	handleTermReorder,
} from "../../../src/api/handlers/taxonomies.js";
import { POST as enableUser } from "../../../src/astro/routes/api/admin/users/[id]/enable.js";
import { PUT as putUser } from "../../../src/astro/routes/api/admin/users/[id]/index.js";
import { DELETE as deleteWidgetArea } from "../../../src/astro/routes/api/widget-areas/[name].js";
import { POST as reorderWidgets } from "../../../src/astro/routes/api/widget-areas/[name]/reorder.js";
import { POST as postWidget } from "../../../src/astro/routes/api/widget-areas/[name]/widgets.js";
import {
	DELETE as deleteWidget,
	PUT as putWidget,
} from "../../../src/astro/routes/api/widget-areas/[name]/widgets/[id].js";
import { POST as postWidgetArea } from "../../../src/astro/routes/api/widget-areas/index.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { withTransaction } from "../../../src/database/transaction.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { setChangePublisher, type Change } from "../../../src/realtime/publish.js";
import { setSiteSettings } from "../../../src/settings/index.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

class RecordingPublisher {
	readonly changes: Change[] = [];
	calls = 0;

	publish(changes: Change[]): Promise<void> {
		this.calls++;
		this.changes.push(...changes);
		return Promise.resolve();
	}

	async take(): Promise<Change[]> {
		await waitForDeferredTasks();
		return this.changes.splice(0);
	}
}

function ok<T>(result: { success: true; data: T } | { success: false; error: unknown }): T {
	if (!result.success) throw new Error(`Expected success: ${JSON.stringify(result.error)}`);
	return result.data;
}

describeEachDialect("Realtime publishes from admin writers", (dialect) => {
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

	const admin = { id: "user_admin", role: Role.ADMIN };

	function route(params: Record<string, string>, body?: unknown) {
		return {
			params,
			locals: { emdash: { db: ctx.db, storage: null }, user: admin },
			cache: { enabled: false, invalidate: () => Promise.resolve() },
			request: new Request("http://localhost/", {
				method: body === undefined ? "POST" : "PUT",
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		} as never;
	}

	it("publishes widget and widget area writes to widgets", async () => {
		const areaResponse = await postWidgetArea(
			route({}, { name: "Main sidebar", label: "Main sidebar" }),
		);
		expect(areaResponse.status).toBe(201);
		const area = ((await areaResponse.json()) as { data: { id: string } }).data;
		expect(await publisher.take()).toEqual([{ topic: "widgets", ids: [area.id], op: "create" }]);

		const params = { name: "Main sidebar" };
		const widgetResponse = await postWidget(route(params, { type: "content", title: "Hello" }));
		const widget = ((await widgetResponse.json()) as { data: { id: string } }).data;
		expect(await publisher.take()).toEqual([{ topic: "widgets", ids: [widget.id], op: "create" }]);

		await putWidget(route({ ...params, id: widget.id }, { title: "Now" }));
		expect(await publisher.take()).toEqual([{ topic: "widgets", ids: [widget.id], op: "update" }]);

		await reorderWidgets(route(params, { widgetIds: [widget.id] }));
		expect(await publisher.take()).toEqual([{ topic: "widgets", ids: [widget.id], op: "update" }]);

		await deleteWidget(route({ ...params, id: widget.id }));
		expect(await publisher.take()).toEqual([{ topic: "widgets", ids: [widget.id], op: "delete" }]);

		await deleteWidgetArea(route(params));
		expect(await publisher.take()).toEqual([{ topic: "widgets", ids: [area.id], op: "delete" }]);
	});

	it("publishes taxonomy definitions to the taxonomy and the schema, and terms to the taxonomy", async () => {
		ok(await handleTaxonomyCreate(ctx.db, { name: "genre", label: "Genres", hierarchical: false }));
		expect(await publisher.take()).toEqual([
			{ topic: "taxonomies/genre", op: "create" },
			{ topic: "schema", op: "update" },
		]);
		expect(publisher.calls).toBe(1);

		const { term } = ok(await handleTermCreate(ctx.db, "genre", { label: "Jazz" }));
		expect(await publisher.take()).toEqual([
			{ topic: "taxonomies/genre", ids: [term.id], op: "create" },
		]);

		const repo = new TaxonomyRepository(ctx.db);
		await repo.update(term.id, { label: "Bebop" });
		expect(await publisher.take()).toEqual([
			{ topic: "taxonomies/genre", ids: [term.id], op: "update" },
		]);

		ok(await handleTermReorder(ctx.db, "genre", { ids: [term.id] }));
		expect(await publisher.take()).toEqual([{ topic: "taxonomies/genre", op: "update" }]);

		await repo.delete(term.id);
		expect(await publisher.take()).toEqual([
			{ topic: "taxonomies/genre", ids: [term.id], op: "delete" },
		]);
	});

	it("publishes bylines", async () => {
		const repo = new BylineRepository(ctx.db);
		const byline = await repo.create({ slug: "ada", displayName: "Ada" });
		await repo.update(byline.id, { displayName: "Ada L." });
		await repo.delete(byline.id);

		expect(await publisher.take()).toEqual([
			{ topic: "bylines", ids: [byline.id], op: "create" },
			{ topic: "bylines", ids: [byline.id], op: "update" },
			{ topic: "bylines", ids: [byline.id], op: "delete" },
		]);
	});

	it("publishes sections", async () => {
		const section = ok(
			await handleSectionCreate(ctx.db, { slug: "hero", title: "Hero", content: [] }),
		);
		ok(await handleSectionUpdate(ctx.db, "hero", { title: "Big hero" }));
		ok(await handleSectionDelete(ctx.db, "hero"));

		expect(await publisher.take()).toEqual([
			{ topic: "sections", ids: [section.id], op: "create" },
			{ topic: "sections", ids: [section.id], op: "update" },
			{ topic: "sections", ids: [section.id], op: "delete" },
		]);
	});

	it("publishes media once it's in the library, and folders to media", async () => {
		const repo = new MediaRepository(ctx.db);
		const pending = await repo.createPending({
			filename: "a.png",
			mimeType: "image/png",
			storageKey: "a.png",
		});
		expect(await publisher.take()).toEqual([]);

		await repo.confirmUpload(pending.id);
		await repo.update(pending.id, { alt: "A" });
		await repo.delete(pending.id);
		expect(await publisher.take()).toEqual([
			{ topic: `media/${pending.id}`, op: "create" },
			{ topic: `media/${pending.id}`, op: "update" },
			{ topic: `media/${pending.id}`, op: "delete" },
		]);

		const folder = await new MediaFolderRepository(ctx.db).create("Photos");
		expect(await publisher.take()).toEqual([{ topic: "media", ids: [folder.id], op: "create" }]);
	});

	it("publishes redirects after their write commits", async () => {
		const repo = new RedirectRepository(ctx.db);
		const redirect = await repo.create({ source: "/old", destination: "/new" });
		await repo.update(redirect.id, { destination: "/newer" });
		await repo.delete(redirect.id);

		expect(await publisher.take()).toEqual([
			{ topic: "redirects", ids: [redirect.id], op: "create" },
			{ topic: "redirects", ids: [redirect.id], op: "update" },
			{ topic: "redirects", ids: [redirect.id], op: "delete" },
		]);
	});

	it("publishes no redirect from a write that rolls back", async () => {
		await expect(
			withTransaction(ctx.db, async (trx) => {
				await new RedirectRepository(trx).create({ source: "/lost", destination: "/new" });
				throw new Error("Refused");
			}),
		).rejects.toThrow("Refused");

		expect(await publisher.take()).toEqual([]);
	});

	it("publishes settings", async () => {
		await setSiteSettings({ title: "New title" }, ctx.db);

		expect(await publisher.take()).toEqual([{ topic: "settings", op: "update" }]);
	});

	it("publishes schema changes", async () => {
		ok(
			await handleSchemaCollectionCreate(ctx.db, {
				slug: "article",
				label: "Articles",
				labelSingular: "Article",
			}),
		);
		ok(
			await handleSchemaFieldCreate(ctx.db, "article", {
				slug: "subtitle",
				label: "Subtitle",
				type: "string",
			}),
		);
		ok(
			await handleBylineFieldCreate(ctx.db, { slug: "twitter", label: "Twitter", type: "string" }),
		);
		await new RelationRepository(ctx.db).create({
			slug: "related",
			parentCollection: "article",
			childCollection: "post",
			parentLabel: "Related",
			childLabel: "Related to",
		});

		expect(await publisher.take()).toEqual([
			{ topic: "schema", op: "create" },
			{ topic: "schema", op: "update" },
			{ topic: "schema", op: "update" },
			{ topic: "schema", op: "update" },
		]);
	});

	it("closes a user's sockets only when their access changes", async () => {
		const target = "user_target";
		await ctx.db
			.insertInto("users")
			.values([
				{
					id: admin.id,
					email: "admin@example.com",
					name: "Admin",
					role: Role.ADMIN,
					email_verified: 1,
					disabled: 0,
				},
				{
					id: target,
					email: "target@example.com",
					name: "Target",
					role: Role.AUTHOR,
					email_verified: 1,
					disabled: 1,
				},
			])
			.execute();

		await putUser(route({ id: target }, { name: "Renamed" }));
		await putUser(route({ id: target }, { role: Role.EDITOR }));
		await enableUser(route({ id: target }));

		expect(await publisher.take()).toEqual([
			{ topic: "users", ids: [target], op: "update" },
			{ topic: `users/${target}`, op: "update" },
			{ topic: "users", ids: [target], op: "update" },
		]);
	});

	it("publishes plugin state", async () => {
		const repo = new PluginStateRepository(ctx.db);
		await repo.enable("forms", "1.0.0");
		await repo.disable("forms", "1.0.0");
		await repo.delete("forms");

		expect(await publisher.take()).toEqual([
			{ topic: "plugins", ids: ["forms"], op: "create" },
			{ topic: "plugins", ids: ["forms"], op: "update" },
			{ topic: "plugins", ids: ["forms"], op: "delete" },
		]);
	});
});
