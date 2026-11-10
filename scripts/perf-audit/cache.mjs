import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export async function publishSeed(parent, key, build) {
	mkdirSync(parent, { recursive: true });
	const destination = join(parent, key);
	if (existsSync(join(destination, "ready"))) return destination;
	const temporary = mkdtempSync(join(parent, `${key}-building-`));
	try {
		await build(temporary);
		mkdirSync(join(temporary, "ready"));
		try {
			renameSync(temporary, destination);
		} catch (error) {
			if (!existsSync(join(destination, "ready"))) throw error;
		}
		return destination;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
