import assert from "node:assert/strict";
import test from "node:test";

import {
	assertOwnedDomain,
	assertOwnedName,
	classifyImageUrl,
	coldStartProblems,
	createRunId,
	domainConflict,
	evaluateImage,
	exitCode,
	isOwnedName,
	oversizeRatio,
	pageProblems,
	parseOptions,
	renderSummary,
	resourceNames,
	runProblems,
	runStatus,
	UsageError,
	zoneCandidates,
} from "./lib.mjs";

const includes = (text) => new RegExp(RegExp.escape(text));
const pattern = (source) => new RegExp(source);

void test("run IDs are 8 lowercase alphanumerics and name every resource with the prefix", () => {
	const runId = createRunId(Buffer.from([0, 25, 26, 35, 36, 61, 200, 255]));
	assert.equal(runId, "az09azud");
	assert.deepEqual(resourceNames(runId), {
		worker: "emdash-perf-az09azud",
		d1: "emdash-perf-az09azud",
		r2: "emdash-perf-az09azud",
		kv: "emdash-perf-az09azud-session",
	});
	assert.match(createRunId(), pattern("^[a-z0-9]{8}$"));
	assert.throws(() => resourceNames("../etc"), includes("Invalid run ID"));
});

void test("only the run's exact resource names count as owned", () => {
	assert.equal(isOwnedName("emdash-perf-abcd1234", "abcd1234"), true);
	assert.equal(isOwnedName("emdash-perf-abcd1234-session", "abcd1234"), true);
	assert.equal(isOwnedName("emdash-perf-abcd12345", "abcd1234"), false);
	assert.equal(isOwnedName("emdash-perf-zzzz9999", "abcd1234"), false);
	assert.equal(isOwnedName("astroblog", "abcd1234"), false);
	assert.equal(isOwnedName("emdash-perf-", "abcd1234"), false);
	assert.equal(isOwnedName(undefined, "abcd1234"), false);
	assert.equal(isOwnedName("emdash-perf-abcd1234", ""), false);
	assert.throws(
		() => assertOwnedName("Worker", "astroblog", "abcd1234"),
		includes('Refusing to delete Worker "astroblog"'),
	);
	assert.doesNotThrow(() => assertOwnedName("Worker", "emdash-perf-abcd1234", "abcd1234"));
});

void test("a custom domain is deletable only when it is the run's hostname on the run's Worker", () => {
	const owner = { hostname: "perf.example.com", runId: "abcd1234" };
	assert.doesNotThrow(() =>
		assertOwnedDomain({ hostname: "perf.example.com", service: "emdash-perf-abcd1234" }, owner),
	);
	assert.throws(
		() => assertOwnedDomain({ hostname: "perf.example.com", service: "astroblog" }, owner),
		includes("Refusing to delete custom domain"),
	);
	assert.throws(
		() => assertOwnedDomain({ hostname: "example.com", service: "emdash-perf-abcd1234" }, owner),
		includes("Refusing to delete custom domain"),
	);
});

void test("an existing attachment to another Worker blocks the run", () => {
	const owner = { hostname: "perf.example.com", runId: "abcd1234" };
	assert.equal(domainConflict([], owner), null);
	assert.equal(
		domainConflict([{ hostname: "perf.example.com", service: "emdash-perf-abcd1234" }], owner),
		null,
	);
	assert.match(
		domainConflict([{ hostname: "perf.example.com", service: "astroblog" }], owner),
		includes('already attached to Worker "astroblog"'),
	);
});

void test("zone candidates never include the hostname itself", () => {
	assert.deepEqual(zoneCandidates("a.b.example.com"), ["b.example.com", "example.com"]);
	assert.deepEqual(zoneCandidates("perf.example.com"), ["example.com"]);
});

void test("parses a run with defaults", () => {
	assert.deepEqual(parseOptions(["--hostname", "Perf.Example.com."]), {
		mode: "run",
		hostname: "perf.example.com",
		imageService: "cloudflare",
		accountId: undefined,
		idleGapSeconds: 300,
		keep: false,
		siteUrlAtBuild: true,
	});
	const options = parseOptions([
		"--hostname=perf.example.com",
		"--image-service",
		"binding",
		"--idle-gap",
		"0",
		"--keep",
		"--as-shipped",
		"--account-id",
		"0123456789abcdef0123456789abcdef",
	]);
	assert.equal(options.imageService, "binding");
	assert.equal(options.idleGapSeconds, 0);
	assert.equal(options.keep, true);
	assert.equal(options.siteUrlAtBuild, false);
	assert.equal(options.accountId, "0123456789abcdef0123456789abcdef");
});

void test("parses a teardown and rejects run flags alongside it", () => {
	assert.deepEqual(parseOptions(["--teardown", "abcd1234"]), {
		mode: "teardown",
		runId: "abcd1234",
		accountId: undefined,
	});
	assert.throws(
		() => parseOptions(["--teardown", "abcd1234", "--keep"]),
		includes("--keep cannot be combined"),
	);
	assert.throws(
		() => parseOptions(["--teardown", "abcd1234", "--hostname", "perf.example.com"]),
		includes("--hostname cannot be combined"),
	);
	assert.throws(() => parseOptions(["--teardown", "../../etc"]), UsageError);
});

void test("rejects invalid run options", () => {
	assert.throws(() => parseOptions([]), includes("--hostname is required"));
	assert.throws(() => parseOptions(["--hostname", "example.com"]), includes("must be a subdomain"));
	assert.throws(
		() => parseOptions(["--hostname=-bad.example.com"]),
		includes("must be a subdomain"),
	);
	assert.throws(
		() => parseOptions(["--hostname", "a b.example.com"]),
		includes("must be a subdomain"),
	);
	assert.throws(
		() => parseOptions(["--hostname", "p.example.com", "--image-service", "sharp"]),
		includes("--image-service"),
	);
	assert.throws(
		() => parseOptions(["--hostname", "p.example.com", "--idle-gap", "1.5"]),
		includes("--idle-gap"),
	);
	assert.throws(
		() => parseOptions(["--hostname", "p.example.com", "--account-id", "nope"]),
		includes("--account-id"),
	);
	assert.throws(() => parseOptions(["--hostname", "p.example.com", "--bogus"]), UsageError);
	assert.deepEqual(parseOptions(["--help"]), { mode: "help" });
});

void test("classifies media delivered directly, through /_image and through /cdn-cgi/image", () => {
	const origin = "https://perf.example.com";
	const media = "https://perf.example.com/_emdash/api/media/file/01ABC.jpg";
	assert.deepEqual(classifyImageUrl(`${origin}/_emdash/api/media/file/01ABC.jpg`, origin), {
		isMedia: true,
		viaCdnCgi: false,
		viaImageEndpoint: false,
		sameOrigin: true,
	});
	assert.deepEqual(
		classifyImageUrl(`${origin}/_image?href=${encodeURIComponent(media)}&w=400`, origin),
		{
			isMedia: true,
			viaCdnCgi: false,
			viaImageEndpoint: true,
			sameOrigin: true,
		},
	);
	assert.deepEqual(
		classifyImageUrl(
			`${origin}/cdn-cgi/image/onerror=redirect,width=640,format=webp/${media}`,
			origin,
		),
		{ isMedia: true, viaCdnCgi: true, viaImageEndpoint: false, sameOrigin: true },
	);
	assert.equal(classifyImageUrl(`${origin}/_astro/logo.abc.svg`, origin).isMedia, false);
	assert.equal(
		classifyImageUrl(`https://cdn.example.net/_emdash/api/media/file/x.jpg`, origin).isMedia,
		false,
	);
	assert.equal(classifyImageUrl("data:image/svg+xml,<svg/>", origin).isMedia, false);
});

void test("oversize ratio follows object-fit", () => {
	const box = { renderedWidth: 100, renderedHeight: 100, dpr: 1 };
	assert.equal(
		oversizeRatio({ ...box, naturalWidth: 400, naturalHeight: 200, objectFit: "cover" }),
		2,
	);
	assert.equal(
		oversizeRatio({ ...box, naturalWidth: 400, naturalHeight: 200, objectFit: "contain" }),
		4,
	);
	assert.equal(
		oversizeRatio({ ...box, dpr: 2, naturalWidth: 400, naturalHeight: 400, objectFit: "fill" }),
		2,
	);
	assert.equal(
		oversizeRatio({ ...box, naturalWidth: 0, naturalHeight: 0, objectFit: "fill" }),
		null,
	);
});

void test("a media image fails only when it is both more than 2x oversized and over 50 KB", () => {
	const base = {
		isMedia: true,
		renderedWidth: 176,
		renderedHeight: 99,
		dpr: 1,
		objectFit: "cover",
		status: 200,
	};
	const reported = evaluateImage({
		...base,
		naturalWidth: 1600,
		naturalHeight: 1000,
		bytes: 647 * 1024,
	});
	assert.equal(reported.oversized, true);
	assert.equal(reported.failed, true);
	assert.equal(reported.oversizeRatio, 9.09);

	assert.equal(
		evaluateImage({ ...base, naturalWidth: 1600, naturalHeight: 1000, bytes: 40 * 1024 }).failed,
		false,
	);
	assert.equal(
		evaluateImage({ ...base, naturalWidth: 352, naturalHeight: 198, bytes: 80 * 1024 }).failed,
		false,
	);
	assert.equal(
		evaluateImage({ ...base, naturalWidth: 353, naturalHeight: 199, bytes: 80 * 1024 }).failed,
		true,
	);
	assert.equal(
		evaluateImage({
			...base,
			isMedia: false,
			naturalWidth: 1600,
			naturalHeight: 1000,
			bytes: 647 * 1024,
		}).failed,
		false,
	);
});

void test("a media image that fails to load is broken", () => {
	const base = {
		isMedia: true,
		renderedWidth: 300,
		renderedHeight: 200,
		dpr: 1,
		objectFit: "fill",
	};
	const missing = evaluateImage({
		...base,
		naturalWidth: 0,
		naturalHeight: 0,
		status: 404,
		bytes: null,
	});
	assert.equal(missing.broken, true);
	assert.equal(missing.oversized, false);
	assert.equal(missing.failed, true);
	assert.equal(
		evaluateImage({ ...base, isMedia: false, naturalWidth: 0, naturalHeight: 0, status: 404 })
			.failed,
		false,
	);
});

void test("the summary reports FAIL with each oversized image", () => {
	const image = evaluateImage({
		isMedia: true,
		viaImageEndpoint: true,
		viaCdnCgi: false,
		url: "https://perf.example.com/_image?href=x&w=400",
		renderedWidth: 176,
		renderedHeight: 99,
		dpr: 1,
		objectFit: "cover",
		naturalWidth: 1600,
		naturalHeight: 1000,
		bytes: 647 * 1024,
		status: 200,
	});
	const summary = renderSummary({
		run: {
			runId: "abcd1234",
			hostname: "perf.example.com",
			imageService: "cloudflare",
			startedAt: "now",
		},
		pages: [{ name: "Admin media library", viewport: "desktop", images: [image] }],
		coldStarts: [],
		errors: [],
	});
	assert.match(summary, pattern("^# EmDash deploy check: FAIL"));
	assert.match(
		summary,
		includes("| Admin media library | desktop | 1600×1000 | 176×99 | 9.09x | 647 KB |"),
	);
	assert.match(renderSummary(passingRun()), pattern("^# EmDash deploy check: PASS"));
});

const okSample = (over = {}) => ({ status: 200, ttfbMs: 40, serverMs: 20, ...over });

const mediaImage = (over = {}) =>
	evaluateImage({
		isMedia: true,
		viaImageEndpoint: true,
		viaCdnCgi: false,
		url: "https://perf.example.com/_image?href=x&w=400",
		renderedWidth: 400,
		renderedHeight: 300,
		dpr: 1,
		objectFit: "cover",
		naturalWidth: 400,
		naturalHeight: 300,
		bytes: 20 * 1024,
		status: 200,
		...over,
	});

const renderedPage = (over = {}) => ({
	name: "Home",
	path: "/",
	viewport: "desktop",
	status: 200,
	finalPath: "/",
	content: { expected: { selector: "main", minMedia: 1 }, found: true, booting: false },
	images: [mediaImage()],
	...over,
});

const coldSample = (over = {}) => ({
	moment: "after deploy",
	label: "GET / (logged out)",
	cold: okSample(),
	warm: [okSample(), okSample()],
	...over,
});

function passingRun(over = {}) {
	return {
		run: {
			runId: "abcd1234",
			hostname: "perf.example.com",
			imageService: "binding",
			startedAt: "now",
		},
		pages: [renderedPage()],
		coldStarts: [coldSample()],
		errors: [],
		...over,
	};
}

void test("a run whose pages rendered and whose samples got 2xx passes with exit 0", () => {
	assert.deepEqual(runProblems(passingRun()), []);
	assert.equal(runStatus(passingRun()), "PASS");
	assert.equal(exitCode(passingRun()), 0);
});

void test("an HTTP 500 document with no images fails (reviewer reproduction)", () => {
	const results = passingRun({
		pages: [
			renderedPage({
				name: "Home error",
				status: 500,
				content: { expected: { selector: "main", minMedia: 1 }, found: false, booting: false },
				images: [],
			}),
		],
	});
	const summary = renderSummary(results);
	assert.match(summary, pattern("^# EmDash deploy check: FAIL"));
	assert.match(
		summary,
		includes(
			"- Home error (desktop): document status 500; no main element; 0 media images, expected at least 1",
		),
	);
	assert.match(summary, includes("| Home error | desktop | 500 | 0 | 0 |"));
	assert.equal(exitCode(results), 1);
});

void test("a page fails without its landmark, while booting, or with too few media images", () => {
	assert.deepEqual(pageProblems(renderedPage({ status: null })), ["no document response"]);
	assert.deepEqual(
		pageProblems(
			renderedPage({
				name: "Admin editor",
				path: "/_emdash/admin/content/posts/1",
				finalPath: "/_emdash/admin/login",
				content: { expected: { selector: "main" }, found: false, booting: false },
			}),
		),
		["no main element (ended at /_emdash/admin/login)"],
	);
	assert.deepEqual(
		pageProblems(
			renderedPage({ content: { expected: { selector: "main" }, found: false, booting: true } }),
		),
		["still showing the admin boot loader", "no main element"],
	);
	assert.deepEqual(
		pageProblems(
			renderedPage({
				content: { expected: { selector: "main", minMedia: 3 }, found: true, booting: false },
				images: [mediaImage(), mediaImage({ isMedia: false })],
			}),
		),
		["1 media images, expected at least 3"],
	);
	assert.equal(exitCode(passingRun({ pages: [renderedPage({ status: 404 })] })), 1);
});

void test("a cold or warm sample without a 2xx fails the run", () => {
	const cold = passingRun({ coldStarts: [coldSample({ cold: okSample({ status: 500 }) })] });
	assert.deepEqual(runProblems(cold), [
		{ where: "after deploy: GET / (logged out)", detail: "cold status 500" },
	]);
	assert.match(
		renderSummary(cold),
		includes("- after deploy: GET / (logged out): cold status 500"),
	);
	assert.equal(exitCode(cold), 1);
	const warm = passingRun({
		coldStarts: [coldSample({ warm: [okSample(), okSample({ status: 302 })] })],
	});
	assert.deepEqual(coldStartProblems(warm.coldStarts[0]), ["1 of 2 warm samples got 302"]);
	assert.equal(exitCode(warm), 1);
});

void test("a run without pages or cold starts fails unless a stage already errored", () => {
	assert.deepEqual(
		runProblems(passingRun({ pages: [], coldStarts: [] })).map((p) => p.detail),
		["no pages were measured", "no cold starts were sampled"],
	);
	assert.equal(exitCode(passingRun({ pages: [] })), 1);
	const errored = passingRun({
		pages: [],
		coldStarts: [],
		errors: [{ stage: "deploy", message: "x" }],
	});
	assert.deepEqual(runProblems(errored), []);
	assert.equal(runStatus(errored), "ERROR");
	assert.equal(exitCode(errored), 2);
});

void test("image failures still fail a rendered run", () => {
	const results = passingRun({
		pages: [renderedPage({ images: [mediaImage({ status: 404, naturalWidth: 0 })] })],
	});
	assert.deepEqual(runProblems(results), []);
	assert.equal(exitCode(results), 1);
});
