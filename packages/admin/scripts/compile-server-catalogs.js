/**
 * Writes `src/locales/<code>/server-catalog.mjs` for every compiled locale: the
 * subset of its catalog that server-side modules (the visual editing toolbar
 * and system emails) resolve. Keeps whole admin catalogs out of server bundles.
 * Run after `lingui compile`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transformAsync, traverse } from "@babel/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, "..", "src", "locales");
const SERVER_SOURCES = ["server.ts", "emails.ts"];

async function collectMessageIds(file) {
	const result = await transformAsync(readFileSync(file, "utf8"), {
		filename: file,
		ast: true,
		code: false,
		babelrc: false,
		configFile: false,
		plugins: ["@lingui/babel-plugin-lingui-macro"],
		parserOpts: { plugins: ["typescript"] },
	});
	const ids = [];
	traverse(result.ast, {
		ObjectExpression(path) {
			if (!path.node.leadingComments?.some((comment) => comment.value === "i18n")) return;
			const id = path.node.properties.find(
				(property) => property.type === "ObjectProperty" && property.key.name === "id",
			);
			if (id?.value.type === "StringLiteral") ids.push(id.value.value);
		},
	});
	return ids;
}

const ids = new Set();
for (const source of SERVER_SOURCES) {
	const found = await collectMessageIds(join(localesDir, source));
	if (found.length === 0) throw new Error(`No Lingui messages found in src/locales/${source}.`);
	for (const id of found) ids.add(id);
}

for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const catalogPath = join(localesDir, entry.name, "messages.mjs");
	if (!existsSync(catalogPath)) continue;
	const { messages } = await import(pathToFileURL(catalogPath).href);
	const subset = Object.fromEntries(
		[...ids].filter((id) => id in messages).map((id) => [id, messages[id]]),
	);
	writeFileSync(
		join(localesDir, entry.name, "server-catalog.mjs"),
		`export const messages = ${JSON.stringify(subset)};\n`,
	);
}
