import {
	AliasNode,
	SelectQueryNode,
	TableNode,
	type Kysely,
	type KyselyPlugin,
	type RootOperationNode,
} from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { getSiteSettingsWithDb, setSiteSettings } from "../../../src/settings/index.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function isMediaSelect(node: RootOperationNode): boolean {
	if (!SelectQueryNode.is(node)) return false;
	const from = node.from?.froms[0];
	const table = from && AliasNode.is(from) ? from.node : from;
	return !!table && TableNode.is(table) && table.table.identifier.name === "media";
}

describeEachDialect("site settings media references", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function addMedia(name: string) {
		return new MediaRepository(db).create({
			filename: `${name}.png`,
			mimeType: "image/png",
			size: 1,
			storageKey: `${name}.png`,
			width: 16,
			height: 16,
		});
	}

	it("resolves the logo, favicon and default share image together", async () => {
		const [logo, favicon, og] = await Promise.all([
			addMedia("logo"),
			addMedia("favicon"),
			addMedia("og"),
		]);
		await setSiteSettings(
			{
				logo: { mediaId: logo.id },
				favicon: { mediaId: favicon.id },
				seo: { defaultOgImage: { mediaId: og.id } },
			},
			db,
		);

		const events: string[] = [];
		const observer: KyselyPlugin = {
			transformQuery({ node }) {
				if (isMediaSelect(node)) events.push("start");
				return node;
			},
			async transformResult({ result }) {
				if (events.includes("start")) events.push("end");
				return result;
			},
		};

		const settings = await getSiteSettingsWithDb(db.withPlugin(observer));

		expect(events.slice(0, 3)).toEqual(["start", "start", "start"]);
		expect(settings.logo?.url).toBe("/_emdash/api/media/file/logo.png");
		expect(settings.favicon?.contentType).toBe("image/png");
		expect(settings.seo?.defaultOgImage?.url).toBe("/_emdash/api/media/file/og.png");
	});
});
