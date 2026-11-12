/**
 * Measurement failures that make a run exit non-zero regardless of budgets:
 * profiles or measurements that threw, server errors, screens that did not
 * render what they should, scenarios that errored, cold starts that got an
 * error status, and query plans that could not be read.
 */

const BROKEN_RESOURCE_TYPES = new Set(["Script", "Stylesheet", "Image"]);

function firstLine(text) {
	return String(text ?? "").split("\n")[0];
}

function sameOrigin(url, origin) {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/** Why a measured screen does not count as rendered, or an empty list. */
export function pageProblems(page, origin) {
	const problems = [];
	if (page.status === null || page.status === undefined) problems.push("no document response");
	else if (page.status >= 400) problems.push(`document status ${page.status}`);
	const content = page.content;
	if (content) {
		if (content.booting) problems.push("still showing the admin boot loader");
		const expected = content.expected ?? {};
		if (expected.selector && !content.found) problems.push(`no ${expected.selector} element`);
		if (expected.minImages && content.images < expected.minImages) {
			problems.push(`${content.images} images, expected at least ${expected.minImages}`);
		}
	}
	for (const r of page.waterfall ?? []) {
		if (!BROKEN_RESOURCE_TYPES.has(r.type) || !(r.status >= 400) || r.status >= 500) continue;
		if (origin && !sameOrigin(r.url, origin)) continue;
		problems.push(`${r.type.toLowerCase()} ${r.status}: ${r.url.replace(origin ?? "", "")}`);
	}
	return problems;
}

function scenarioErrors(scenario) {
	const errors = [scenario.error, ...(scenario.samples ?? []).map((s) => s.error)].filter(Boolean);
	return [...new Set(errors)];
}

function profileFailures(p, label) {
	const out = [];
	const add = (check, where, detail) => out.push({ profile: label, check, where, detail });
	for (const e of p.errors ?? []) add("measurement failed", e.measurement, firstLine(e.error));
	for (const f of p.failedResponses ?? []) {
		add(
			"server error",
			f.where,
			`${f.status} ${f.path}${f.count > 1 ? ` (${f.count} times)` : ""}`,
		);
	}
	for (const page of p.pages ?? []) {
		const problems = pageProblems(page, p.origin);
		if (problems.length > 0)
			add("screen not rendered", `${page.viewport} ${page.name}`, problems.join("; "));
	}
	for (const s of p.scenarios ?? []) {
		const errors = scenarioErrors(s);
		if (errors.length > 0) add("scenario errored", s.name, firstLine(errors.join("; ")));
	}
	for (const [key, sample] of Object.entries(p.coldStart ?? {})) {
		const statuses = sample?.samplesStatus ?? [sample?.status];
		if (statuses.some((status) => status >= 400)) {
			add("cold start", key, `${sample.path} got ${statuses.join(", ")}`);
		}
	}
	if (p.queryLog === "unavailable") {
		add("query log", "server output", "the server logged no queries, so every query count reads 0");
	}
	if (Array.isArray(p.queryPlans)) {
		if (p.queryPlans.length === 0) add("query plans", "all requests", "no queries were explained");
		for (const q of p.queryPlans) {
			if (q.error) add("query plans", q.request, firstLine(q.error));
		}
	}
	return out;
}

function selectedSomething(p) {
	const s = p.selected ?? {};
	return s.screens > 0 || s.scenarios > 0 || s.writes === true || s.queryPlans === true;
}

/** Every failure in a finished run, from both workspaces. */
export function runFailures(run) {
	const out = [];
	for (const e of run.errors ?? []) {
		out.push({
			profile: e.profile,
			check: "profile failed",
			where: "",
			detail: firstLine(e.error),
		});
	}
	for (const p of run.profiles ?? []) out.push(...profileFailures(p, p.profile));
	for (const p of run.compareProfiles ?? [])
		out.push(...profileFailures(p, `${p.profile} (compare)`));
	const only = run.options?.only ?? [];
	const all = [...(run.profiles ?? []), ...(run.compareProfiles ?? [])];
	if (only.length > 0 && all.length > 0 && !all.some(selectedSomething)) {
		out.push({
			profile: "all",
			check: "nothing selected",
			where: `--only ${only.join(" ")}`,
			detail: "matched no screen, scenario, write pass or query plan",
		});
	}
	return out;
}

/** The CLI's exit code: 1 for any failure, budget overrun or cold-start burst failure. */
export function exitCode(run) {
	const failed =
		(run.failures ?? runFailures(run)).length > 0 ||
		(run.budgetFailures ?? []).length > 0 ||
		(run.burstFailures ?? []).length > 0;
	return failed ? 1 : 0;
}
