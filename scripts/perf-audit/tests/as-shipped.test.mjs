import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkAsShipped, importersOf } from "../lib/as-shipped.mjs";

const NOT_DECLARED = /does not declare it/;

function fixture({ dependencies = {}, installed = [], server = {} }) {
	const root = mkdtempSync(join(tmpdir(), "perf-audit-shipped-"));
	const templateDir = join(root, "template");
	const serverDir = join(root, "site/dist/server");
	mkdirSync(templateDir, { recursive: true });
	writeFileSync(join(templateDir, "package.json"), JSON.stringify({ dependencies }));
	for (const name of installed) {
		mkdirSync(join(templateDir, "node_modules", name), { recursive: true });
		writeFileSync(
			join(templateDir, "node_modules", name, "package.json"),
			JSON.stringify({ name }),
		);
	}
	for (const [file, text] of Object.entries(server)) {
		mkdirSync(join(serverDir, file, ".."), { recursive: true });
		writeFileSync(join(serverDir, file), text);
	}
	return { root, templateDir, serverDir };
}

void test("finds static, dynamic and require imports of a package", () => {
	const f = fixture({
		server: {
			"a.mjs": 'const s = await import("sharp");',
			"chunks/b.mjs": "import sharp from 'sharp';",
			"c.mjs": 'require("sharp/lib/index.js")',
			"d.mjs": 'import x from "sharp-ish"; const t = "sharp";',
		},
	});
	try {
		assert.deepEqual(importersOf(f.serverDir, "sharp").toSorted(), [
			"a.mjs",
			"c.mjs",
			"chunks/b.mjs",
		]);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

void test("a server import the template does not provide is a product finding", () => {
	const f = fixture({ server: { "entry.mjs": 'await import("sharp")' } });
	try {
		const [check] = checkAsShipped({ ...f, template: "blog", packages: ["sharp"] });
		assert.equal(check.declared, false);
		assert.equal(check.resolvable, false);
		assert.match(check.finding, NOT_DECLARED);
	} finally {
		rmSync(f.root, { recursive: true, force: true });
	}
});

void test("a declared and installed package, or an unused one, is not a finding", () => {
	const declared = fixture({
		dependencies: { sharp: "^0.34.0" },
		installed: ["sharp"],
		server: { "entry.mjs": 'await import("sharp")' },
	});
	const unused = fixture({ server: { "entry.mjs": "export {}" } });
	try {
		assert.equal(
			checkAsShipped({ ...declared, template: "blog", packages: ["sharp"] })[0].finding,
			null,
		);
		assert.equal(
			checkAsShipped({ ...unused, template: "blog", packages: ["sharp"] })[0].finding,
			null,
		);
	} finally {
		rmSync(declared.root, { recursive: true, force: true });
		rmSync(unused.root, { recursive: true, force: true });
	}
});
