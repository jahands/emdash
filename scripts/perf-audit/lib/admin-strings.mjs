/**
 * Admin strings in the run's locale, read from the measured workspace's
 * Lingui catalog, so scenarios find controls by the name a user of that
 * locale sees. An untranslated message falls back to English, as Lingui
 * does in the admin.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ESCAPES = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
const ESCAPE_SEQUENCE = /\\(.)/g;
const QUOTED = /^"(.*)"$/;
const ENTRY_KEY = /^(msgctxt|msgid|msgstr)\s+(".*")$/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function unquote(line) {
	const match = QUOTED.exec(line.trim());
	return match ? match[1].replace(ESCAPE_SEQUENCE, (_, c) => ESCAPES[c] ?? c) : "";
}

/** msgid -> msgstr for every entry with a translation. */
export function parsePo(text) {
	const out = new Map();
	let entry = {};
	let key = null;
	const flush = () => {
		if (entry.msgid && entry.msgstr && !out.has(entry.msgid)) out.set(entry.msgid, entry.msgstr);
		entry = {};
		key = null;
	};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("#")) continue;
		const match = ENTRY_KEY.exec(line);
		if (match) {
			if (match[1] === "msgctxt" || (match[1] === "msgid" && entry.msgstr !== undefined)) flush();
			key = match[1];
			entry[key] = unquote(match[2]);
		} else if (key && line.startsWith('"')) {
			entry[key] += unquote(line);
		}
	}
	flush();
	return out;
}

export function loadAdminCatalog(workspace, locale) {
	if (locale === "en") return new Map();
	const file = join(workspace, "packages/admin/src/locales", locale, "messages.po");
	return existsSync(file) ? parsePo(readFileSync(file, "utf8")) : new Map();
}

/** A matcher for the accessible names of `english` messages in the catalog's locale. */
export function namesMatcher(catalog, english) {
	const names = english.map((m) => (catalog.get(m) ?? m).replace(REGEX_SPECIAL, "\\$&"));
	return new RegExp(`^\\s*(?:${names.join("|")})\\s*$`, "i");
}
