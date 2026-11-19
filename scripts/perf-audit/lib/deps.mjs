/**
 * Third-party modules the harness itself needs, resolved from packages that
 * already depend on them in this checkout so the root manifest stays as is.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const harnessRoot = resolve(import.meta.dirname, "../../..");

function requireFrom(anchorPackageDir, name) {
	const anchor = realpathSync(resolve(harnessRoot, anchorPackageDir));
	return createRequire(resolve(anchor, "package.json"))(name);
}

let sharp;
export function loadSharp() {
	sharp ??= requireFrom("templates/blog/node_modules/astro", "sharp");
	return sharp;
}

let pg;
export function loadPg() {
	pg ??= requireFrom("packages/core", "pg");
	return pg;
}
