import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(
	new URL("../../packages/admin/tests/utils/visible-state.ts", import.meta.url),
	"utf8",
);
const { captureVisibleState, assertVisibleState } = await import(
	`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`
);
export { assertVisibleState };
export const captureGeometry = (page, options) => page.evaluate(captureVisibleState, options);
