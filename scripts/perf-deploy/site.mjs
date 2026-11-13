import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { runCommand } from "./cloudflare.mjs";

const TRAILING_COMMA_FOLLOWER = /^\s*[}\]]/;
const ADAPTER_CALL = "adapter: cloudflare(),";

/**
 * Walk JSON text outside string literals. `visit` returns the text to emit for
 * the character at `i` and how many characters it consumed.
 */
function mapOutsideStrings(text, visit) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length;) {
		const char = text[i];
		if (inString) {
			const escaped = char === "\\";
			out += escaped ? text.slice(i, i + 2) : char;
			if (char === '"') inString = false;
			i += escaped ? 2 : 1;
		} else if (char === '"') {
			inString = true;
			out += char;
			i++;
		} else {
			const [emit, consumed] = visit(text, i);
			out += emit;
			i += consumed;
		}
	}
	return out;
}

/** Remove comments and trailing commas from JSONC, leaving strings intact. */
export function stripJsonc(text) {
	const withoutComments = mapOutsideStrings(text, (source, i) => {
		if (source.startsWith("//", i)) {
			const end = source.indexOf("\n", i);
			return ["", (end === -1 ? source.length : end) - i];
		}
		if (source.startsWith("/*", i)) {
			const end = source.indexOf("*/", i + 2);
			return ["", (end === -1 ? source.length : end + 2) - i];
		}
		return [source[i], 1];
	});
	return mapOutsideStrings(withoutComments, (source, i) => {
		if (source[i] === "," && TRAILING_COMMA_FOLLOWER.test(source.slice(i + 1))) return ["", 1];
		return [source[i], 1];
	});
}

/**
 * Point the template's Wrangler config at the run's resources. Everything else
 * (compatibility date and flags, cron trigger, bindings) stays as shipped.
 */
export function patchWranglerConfig(source, { names, d1Id, kvId }) {
	const config = JSON.parse(stripJsonc(source));
	const d1 = config.d1_databases?.find((binding) => binding.binding === "DB");
	const r2 = config.r2_buckets?.find((binding) => binding.binding === "MEDIA");
	if (!d1 || !r2)
		throw new Error("Template wrangler.jsonc no longer has the DB and MEDIA bindings");
	d1.database_name = names.d1;
	d1.database_id = d1Id;
	r2.bucket_name = names.r2;
	config.name = names.worker;
	config.kv_namespaces = [
		...(config.kv_namespaces ?? []).filter((binding) => binding.binding !== "SESSION"),
		{ binding: "SESSION", id: kvId },
	];
	config.workers_dev = false;
	config.preview_urls = false;
	return `${JSON.stringify(config, null, "\t")}\n`;
}

/** Select the Cloudflare adapter's image service in the template's Astro config. */
export function patchAstroConfig(source, imageService) {
	const occurrences = source.split(ADAPTER_CALL).length - 1;
	if (occurrences !== 1) {
		throw new Error(
			`Expected one "${ADAPTER_CALL}" in the template's astro.config.mjs, found ${occurrences}`,
		);
	}
	if (imageService === "binding") return source;
	return source.replace(ADAPTER_CALL, `adapter: cloudflare({ imageService: "cloudflare" }),`);
}

/**
 * Copy the template's tracked files into `siteDir` and link its installed
 * dependencies, so the build uses this workspace's packages exactly as the
 * template resolves them, without writing into the template directory.
 */
export function prepareSite({ templateDir, siteDir, names, d1Id, kvId, imageService }) {
	mkdirSync(siteDir, { recursive: true });
	const files = execFileSync("git", ["ls-files", "-z"], { cwd: templateDir, encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
	for (const file of files) {
		const source = join(templateDir, file);
		const target = join(siteDir, file);
		mkdirSync(dirname(target), { recursive: true });
		if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target);
		else copyFileSync(source, target);
	}
	symlinkSync(join(templateDir, "node_modules"), join(siteDir, "node_modules"));

	const wranglerPath = join(siteDir, "wrangler.jsonc");
	writeFileSync(
		wranglerPath,
		patchWranglerConfig(readFileSync(wranglerPath, "utf8"), { names, d1Id, kvId }),
	);
	const astroPath = join(siteDir, "astro.config.mjs");
	writeFileSync(astroPath, patchAstroConfig(readFileSync(astroPath, "utf8"), imageService));
}

export async function buildSite({ siteDir, logFile, siteUrl }) {
	await runCommand(join(siteDir, "node_modules", ".bin", "astro"), ["build"], {
		cwd: siteDir,
		env: siteUrl ? { EMDASH_SITE_URL: siteUrl } : {},
		logFile,
		quiet: true,
	});
	const deployConfig = JSON.parse(
		readFileSync(join(siteDir, "dist", "server", "wrangler.json"), "utf8"),
	);
	return {
		name: deployConfig.name,
		images: deployConfig.images ?? null,
		kv: deployConfig.kv_namespaces ?? [],
		d1: deployConfig.d1_databases ?? [],
		r2: deployConfig.r2_buckets ?? [],
	};
}

export async function deploySite({ siteDir, wranglerBin, accountId, logFile }) {
	await runCommand(wranglerBin, ["deploy"], {
		cwd: siteDir,
		env: { CLOUDFLARE_ACCOUNT_ID: accountId },
		logFile,
		quiet: true,
	});
}
