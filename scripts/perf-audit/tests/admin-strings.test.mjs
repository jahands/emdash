import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { loadAdminCatalog, namesMatcher, parsePo } from "../lib/admin-strings.mjs";

const workspace = join(import.meta.dirname, "../../..");

void test("catalog entries parse, including wrapped and escaped strings", () => {
	const catalog = parsePo(`msgid ""
msgstr ""
"Language: ar\\n"

#: a.tsx:1
msgid "Save"
msgstr "حفظ"

msgid "Save draft"
msgstr ""

msgctxt "verb"
msgid "Upload"
msgstr ""
"رفع "
"الملفات"
msgid "Say \\"hi\\""
msgstr "قل \\"مرحبا\\""
`);
	assert.equal(catalog.get("Save"), "حفظ");
	assert.equal(catalog.has("Save draft"), false, "untranslated entries fall back to English");
	assert.equal(catalog.get("Upload"), "رفع الملفات");
	assert.equal(catalog.get('Say "hi"'), 'قل "مرحبا"');
	assert.equal(catalog.has(""), false);
});

void test("names match the localized label exactly, or English when untranslated", () => {
	const catalog = new Map([["Save", "حفظ"]]);
	const save = namesMatcher(catalog, ["Save draft", "Save"]);
	assert.ok(save.test("حفظ"));
	assert.ok(save.test(" Save draft "));
	assert.ok(!save.test("Save"), "a translated label no longer matches its English text");
	assert.ok(!save.test("حفظ التغييرات"));
});

void test("an Arabic run looks for the save button by its Arabic name", () => {
	const save = namesMatcher(loadAdminCatalog(workspace, "ar"), ["Save"]);
	assert.ok(!save.test("Save"));
	assert.ok(namesMatcher(loadAdminCatalog(workspace, "en"), ["Save"]).test("Save"));
});
