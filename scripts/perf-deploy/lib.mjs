import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

export const RESOURCE_PREFIX = "emdash-perf-";
export const RUN_ID_PATTERN = /^[a-z0-9]{8}$/;
const RUN_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const TRAILING_DOT = /\.$/;
const HOSTNAME_LABEL_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IMAGE_SERVICES = ["cloudflare", "binding"];
const DEFAULT_IDLE_GAP_SECONDS = 300;

export const OVERSIZE_RATIO_LIMIT = 2;
export const OVERSIZE_BYTES_LIMIT = 50 * 1024;

export const USAGE = `Usage:
  pnpm perf:deploy --hostname <host> [options]
  pnpm perf:deploy --teardown <run-id> [--account-id <id>]

Options:
  --hostname <host>          Custom domain to attach (required). Must be a subdomain
                             of a zone on the account, with no existing DNS record.
  --image-service <mode>     cloudflare (URL mode, /cdn-cgi/image) or binding
                             (IMAGES binding). Default: cloudflare.
  --account-id <id>          Cloudflare account. Default: wrangler's logged-in account.
  --idle-gap <seconds>       Wait before the idle cold-start sample. Default: ${DEFAULT_IDLE_GAP_SECONDS}.
  --as-shipped               Build without EMDASH_SITE_URL. EmDash then cannot authorize
                             its media for Astro's image service, so public pages
                             render originals.
  --keep                     Leave the deployment running instead of tearing it down.
  --teardown <run-id>        Delete the resources of a kept or crashed run.
  --help                     Show this message.
`;

export class UsageError extends Error {}

/** Parse and validate CLI arguments into a normalized options object. */
export function parseOptions(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			strict: true,
			allowPositionals: false,
			options: {
				hostname: { type: "string" },
				"image-service": { type: "string" },
				"account-id": { type: "string" },
				"idle-gap": { type: "string" },
				keep: { type: "boolean", default: false },
				"as-shipped": { type: "boolean", default: false },
				teardown: { type: "string" },
				help: { type: "boolean", default: false },
			},
		});
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const values = parsed.values;
	if (values.help) return { mode: "help" };

	const accountId = values["account-id"];
	if (accountId !== undefined && !ACCOUNT_ID_PATTERN.test(accountId)) {
		throw new UsageError("--account-id must be a 32-character hexadecimal account ID");
	}

	if (values.teardown !== undefined) {
		if (!RUN_ID_PATTERN.test(values.teardown)) {
			throw new UsageError("--teardown expects a run ID of 8 lowercase letters or digits");
		}
		for (const flag of ["hostname", "image-service", "idle-gap", "keep", "as-shipped"]) {
			if (typeof values[flag] === "boolean" ? values[flag] : values[flag] !== undefined) {
				throw new UsageError(`--${flag} cannot be combined with --teardown`);
			}
		}
		return { mode: "teardown", runId: values.teardown, accountId };
	}

	if (values.hostname === undefined) throw new UsageError("--hostname is required");
	const hostname = normalizeHostname(values.hostname);

	const imageService = values["image-service"] ?? "cloudflare";
	if (!IMAGE_SERVICES.includes(imageService)) {
		throw new UsageError(`--image-service must be one of: ${IMAGE_SERVICES.join(", ")}`);
	}

	let idleGapSeconds = DEFAULT_IDLE_GAP_SECONDS;
	if (values["idle-gap"] !== undefined) {
		idleGapSeconds = Number(values["idle-gap"]);
		if (!Number.isInteger(idleGapSeconds) || idleGapSeconds < 0 || idleGapSeconds > 3600) {
			throw new UsageError("--idle-gap must be a whole number of seconds from 0 to 3600");
		}
	}

	return {
		mode: "run",
		hostname,
		imageService,
		accountId,
		idleGapSeconds,
		keep: values.keep,
		siteUrlAtBuild: !values["as-shipped"],
	};
}

/** Lower-case a hostname and reject anything that is not a plain multi-label DNS name. */
export function normalizeHostname(input) {
	const hostname = input.trim().toLowerCase().replace(TRAILING_DOT, "");
	const labels = hostname.split(".");
	if (labels.length < 3 || !labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label))) {
		throw new UsageError(`--hostname must be a subdomain such as perf.example.com, not "${input}"`);
	}
	return hostname;
}

export function createRunId(bytes = randomBytes(8)) {
	let id = "";
	for (const byte of bytes.subarray(0, 8)) id += RUN_ID_ALPHABET[byte % RUN_ID_ALPHABET.length];
	return id;
}

/** Names of every Cloudflare resource a run creates. */
export function resourceNames(runId) {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run ID: ${runId}`);
	const base = `${RESOURCE_PREFIX}${runId}`;
	return { worker: base, d1: base, r2: base, kv: `${base}-session` };
}

/** True only for the exact names `resourceNames(runId)` produces. */
export function isOwnedName(name, runId) {
	if (typeof name !== "string" || !RUN_ID_PATTERN.test(runId)) return false;
	return Object.values(resourceNames(runId)).includes(name);
}

export function assertOwnedName(kind, name, runId) {
	if (!isOwnedName(name, runId)) {
		throw new Error(
			`Refusing to delete ${kind} "${name}": it is not a resource of run ${runId} ` +
				`(expected one of ${Object.values(resourceNames(runId)).join(", ")})`,
		);
	}
}

/**
 * Validate a custom-domain record before deleting it: it must be the run's
 * hostname and point at the run's Worker.
 */
export function assertOwnedDomain(domain, { hostname, runId }) {
	const { worker } = resourceNames(runId);
	if (domain?.hostname !== hostname || domain?.service !== worker) {
		throw new Error(
			`Refusing to delete custom domain ${domain?.hostname ?? "(unknown)"} -> ` +
				`${domain?.service ?? "(unknown)"}: run ${runId} owns only ${hostname} -> ${worker}`,
		);
	}
}

/**
 * Decide whether an existing custom-domain attachment blocks the run. Only an
 * attachment to this run's own Worker (a retry) is acceptable.
 */
export function domainConflict(existing, { hostname, runId }) {
	const { worker } = resourceNames(runId);
	const match = existing.find((domain) => domain.hostname === hostname);
	if (!match || match.service === worker) return null;
	return `${hostname} is already attached to Worker "${match.service}"`;
}

/** Walk up the labels of a hostname to the zone that serves it, never the apex itself. */
export function zoneCandidates(hostname) {
	const labels = hostname.split(".");
	const candidates = [];
	for (let i = 1; i <= labels.length - 2; i++) candidates.push(labels.slice(i).join("."));
	return candidates;
}

export function median(values) {
	const sorted = values.filter((value) => Number.isFinite(value)).toSorted((a, b) => a - b);
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const MEDIA_FILE_PATH = "/_emdash/api/media/file/";

/** Describe how an image URL reached the browser. */
export function classifyImageUrl(rawUrl, origin) {
	let url;
	try {
		url = new URL(rawUrl, origin);
	} catch {
		return { isMedia: false, viaCdnCgi: false, viaImageEndpoint: false, sameOrigin: false };
	}
	const sameOrigin = url.origin === new URL(origin).origin;
	const viaCdnCgi = sameOrigin && url.pathname.startsWith("/cdn-cgi/image/");
	const viaImageEndpoint = sameOrigin && url.pathname === "/_image";
	let source = url.pathname;
	if (viaImageEndpoint) source = url.searchParams.get("href") ?? "";
	if (viaCdnCgi) source = url.pathname.split("/").slice(4).join("/");
	const isMedia = sameOrigin && decodeURIComponent(source).includes(MEDIA_FILE_PATH);
	return { isMedia, viaCdnCgi, viaImageEndpoint, sameOrigin };
}

/**
 * How many times more pixels-per-axis the image carries than its box needs.
 * `cover`/`fill` crop or stretch, so the smaller axis ratio is what is wasted;
 * `contain`/`scale-down` letterbox, so the larger one is.
 */
export function oversizeRatio({
	naturalWidth,
	naturalHeight,
	renderedWidth,
	renderedHeight,
	dpr,
	objectFit,
}) {
	if (!(naturalWidth > 0 && naturalHeight > 0 && renderedWidth > 0 && renderedHeight > 0)) {
		return null;
	}
	const ratioW = naturalWidth / (renderedWidth * dpr);
	const ratioH = naturalHeight / (renderedHeight * dpr);
	const letterboxed = objectFit === "contain" || objectFit === "scale-down";
	return letterboxed ? Math.max(ratioW, ratioH) : Math.min(ratioW, ratioH);
}

/**
 * Attach verdicts to one measured image. Only EmDash media can fail: it is
 * oversized when it is both much larger than its box needs and heavy, and
 * broken when it failed to load.
 */
export function evaluateImage(image) {
	const ratio = oversizeRatio(image);
	const isMedia = image.isMedia === true;
	const oversized =
		isMedia &&
		ratio !== null &&
		ratio > OVERSIZE_RATIO_LIMIT &&
		typeof image.bytes === "number" &&
		image.bytes > OVERSIZE_BYTES_LIMIT;
	const broken =
		isMedia &&
		((typeof image.status === "number" && image.status >= 400) || image.naturalWidth === 0);
	return {
		...image,
		oversizeRatio: ratio === null ? null : round(ratio, 2),
		oversized,
		broken,
		failed: oversized || broken,
	};
}

export function evaluateImages(images) {
	const evaluated = images.map(evaluateImage);
	return { images: evaluated, failures: evaluated.filter((image) => image.failed) };
}

const isOk = (status) => typeof status === "number" && status >= 200 && status < 300;

/** Why a measured page does not count as rendered, or an empty list. */
export function pageProblems(page) {
	const problems = [];
	if (page.status === null || page.status === undefined) problems.push("no document response");
	else if (page.status >= 400) problems.push(`document status ${page.status}`);
	const content = page.content;
	if (!content) return problems;
	const expected = content.expected ?? {};
	if (content.booting) problems.push("still showing the admin boot loader");
	if (expected.selector && !content.found) {
		problems.push(
			`no ${expected.selector} element${page.finalPath && page.finalPath !== page.path ? ` (ended at ${page.finalPath})` : ""}`,
		);
	}
	const media = (page.images ?? []).filter((image) => image.isMedia).length;
	if (expected.minMedia && media < expected.minMedia) {
		problems.push(`${media} media images, expected at least ${expected.minMedia}`);
	}
	return problems;
}

/** Cold and warm samples of one request that did not get a 2xx response. */
export function coldStartProblems(sample) {
	const problems = [];
	if (sample.cold && !isOk(sample.cold.status)) problems.push(`cold status ${sample.cold.status}`);
	const warmFailures = (sample.warm ?? []).filter((w) => !isOk(w.status));
	if (warmFailures.length > 0) {
		problems.push(
			`${warmFailures.length} of ${sample.warm.length} warm samples got ${[...new Set(warmFailures.map((w) => w.status))].join(", ")}`,
		);
	}
	return problems;
}

/**
 * Everything that fails a run besides errors and image verdicts: pages that
 * did not render, cold samples without a 2xx, and measurements a finished
 * run should have but does not.
 */
export function runProblems(results) {
	const out = [];
	const { pages = [], coldStarts = [], errors = [] } = results;
	for (const page of pages) {
		const problems = pageProblems(page);
		if (problems.length > 0)
			out.push({ where: `${page.name} (${page.viewport})`, detail: problems.join("; ") });
	}
	for (const sample of coldStarts) {
		const problems = coldStartProblems(sample);
		if (problems.length > 0)
			out.push({ where: `${sample.moment}: ${sample.label}`, detail: problems.join("; ") });
	}
	if (errors.length === 0) {
		if (pages.length === 0) out.push({ where: "pages", detail: "no pages were measured" });
		if (coldStarts.length === 0)
			out.push({ where: "cold starts", detail: "no cold starts were sampled" });
	}
	return out;
}

function imageFailures(results) {
	return (results.pages ?? []).flatMap((page) =>
		(page.images ?? []).filter((image) => image.failed),
	);
}

/** ERROR when a stage threw, FAIL when a check failed, otherwise PASS. */
export function runStatus(results) {
	if ((results.errors ?? []).length > 0) return "ERROR";
	return runProblems(results).length + imageFailures(results).length > 0 ? "FAIL" : "PASS";
}

/** 2 for errors, 1 for failed checks, 0 for a pass. */
export function exitCode(results) {
	return { ERROR: 2, FAIL: 1, PASS: 0 }[runStatus(results)];
}

function round(value, digits) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

function formatBytes(bytes) {
	if (typeof bytes !== "number") return "?";
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

function formatMs(ms) {
	return typeof ms === "number" ? `${Math.round(ms)} ms` : "—";
}

function shortUrl(rawUrl) {
	try {
		const url = new URL(rawUrl);
		const text = `${url.pathname}${url.search}`;
		return text.length > 90 ? `${text.slice(0, 87)}...` : text;
	} catch {
		return rawUrl;
	}
}

/** Render the human-readable report for a finished run. */
export function renderSummary(results) {
	const lines = [];
	const { run, pages = [], coldStarts = [], errors = [], media = [], reachability } = results;
	const flagged = (key) =>
		pages.flatMap((page) =>
			page.images.filter((image) => image[key]).map((image) => ({ page, image })),
		);
	const oversized = flagged("oversized");
	const broken = flagged("broken");
	const status = runStatus(results);
	const problems = runProblems(results);

	lines.push(`# EmDash deploy check: ${status}`, "");
	lines.push(`- Run: \`${run.runId}\` on \`${run.hostname}\``);
	lines.push(`- Image service: \`${run.imageService}\``);
	lines.push(
		`- EMDASH_SITE_URL at build: ${run.siteUrlAtBuild ? "set to the hostname" : "not set (as shipped)"}`,
	);
	lines.push(`- Commit: \`${run.commit ?? "unknown"}\``);
	lines.push(`- Started: ${run.startedAt}`);
	if (run.finishedAt) lines.push(`- Finished: ${run.finishedAt}`);
	if (typeof run.durationSeconds === "number") lines.push(`- Duration: ${run.durationSeconds} s`);
	lines.push(
		`- Rule: a media image fails when it is more than ${OVERSIZE_RATIO_LIMIT}x larger than its ` +
			`rendered size × DPR and over ${OVERSIZE_BYTES_LIMIT / 1024} KB, or when it fails to load`,
	);
	if (media.length > 0) {
		const sizes = media.map((item) => item.bytes);
		lines.push(
			`- Uploaded: ${media.length} images, ${formatBytes(Math.min(...sizes))} to ${formatBytes(Math.max(...sizes))}`,
		);
	}
	lines.push("");

	if (errors.length > 0) {
		lines.push("## Errors", "");
		for (const error of errors) lines.push(`- ${error.stage}: ${error.message}`);
		lines.push("");
	}

	if (problems.length > 0) {
		lines.push("## Failed checks", "");
		for (const problem of problems) lines.push(`- ${problem.where}: ${problem.detail}`);
		lines.push("");
	}

	lines.push("## Images", "");
	lines.push(
		"| Page | Viewport | Status | Images | Media | Via /cdn-cgi/image | Via /_image | Oversized | Broken |",
	);
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const page of pages) {
		const pageMedia = page.images.filter((image) => image.isMedia);
		lines.push(
			`| ${page.name} | ${page.viewport} | ${page.status ?? "—"} | ${page.images.length} | ${pageMedia.length} | ` +
				`${pageMedia.filter((image) => image.viaCdnCgi).length} | ` +
				`${pageMedia.filter((image) => image.viaImageEndpoint).length} | ` +
				`${page.images.filter((image) => image.oversized).length} | ` +
				`${page.images.filter((image) => image.broken).length} |`,
		);
	}
	lines.push("");

	if (oversized.length > 0) {
		lines.push("### Oversized media", "");
		lines.push("| Page | Viewport | Natural | Needed (CSS × DPR) | Ratio | Bytes | URL |");
		lines.push("| --- | --- | --- | --- | --- | --- | --- |");
		for (const { page, image } of oversized) {
			lines.push(
				`| ${page.name} | ${page.viewport} | ${image.naturalWidth}×${image.naturalHeight} | ` +
					`${Math.round(image.renderedWidth * image.dpr)}×${Math.round(image.renderedHeight * image.dpr)} | ` +
					`${image.oversizeRatio}x | ${formatBytes(image.bytes)} | \`${shortUrl(image.url)}\` |`,
			);
		}
		lines.push("");
	}

	if (broken.length > 0) {
		lines.push("### Broken media", "");
		lines.push("| Page | Viewport | Status | URL |");
		lines.push("| --- | --- | --- | --- |");
		for (const { page, image } of broken) {
			lines.push(
				`| ${page.name} | ${page.viewport} | ${image.status ?? "—"} | \`${shortUrl(image.url)}\` |`,
			);
		}
		lines.push("");
	}

	if (coldStarts.length > 0 || reachability) {
		lines.push("## Cold starts", "");
		lines.push(
			"Each cold sample is the first request on a new connection; the logged-out page and the " +
				"admin API request start together. Server time is time to first byte after the TLS " +
				"handshake, so it includes one network round trip. Warm is the median of the next " +
				"requests.",
			"",
		);
		lines.push("| Moment | Request | Status | Cold TTFB | Cold server | Warm server | Colo |");
		lines.push("| --- | --- | --- | --- | --- | --- | --- |");
		if (reachability?.firstResponse) {
			const first = reachability.firstResponse;
			lines.push(
				`| first request after first deploy, before setup | GET / (logged out) | ${first.status} | ` +
					`${formatMs(first.ttfbMs)} | ${formatMs(first.serverMs)} | — | ${first.colo ?? "—"} |`,
			);
		}
		for (const sample of coldStarts) {
			lines.push(
				`| ${sample.moment} | ${sample.label} | ${sample.cold?.status ?? "—"} | ` +
					`${formatMs(sample.cold?.ttfbMs)} | ${formatMs(sample.cold?.serverMs)} | ` +
					`${formatMs(sample.warmMedianServerMs)} | ${sample.cold?.colo ?? "—"} |`,
			);
		}
		lines.push("");
	}

	return `${lines.join("\n")}\n`;
}
