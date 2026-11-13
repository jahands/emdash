/**
 * Machine load while a measurement ran, and combining repeated runs of a
 * timing-sensitive scenario.
 */

import { cpus, loadavg } from "node:os";

/** Share of CPU time, across all cores, that was not idle between two `os.cpus()` readings. */
export function busyPercent(before, after) {
	let idle = 0;
	let total = 0;
	for (let i = 0; i < Math.min(before.length, after.length); i++) {
		for (const key of Object.keys(after[i].times)) {
			const delta = after[i].times[key] - (before[i].times[key] ?? 0);
			total += delta;
			if (key === "idle") idle += delta;
		}
	}
	return total > 0 ? Math.round(100 * (1 - idle / total)) : null;
}

/** Start sampling machine load; call the result to stop and read it. */
export function sampleMachineLoad() {
	const before = cpus();
	return () => ({
		cpuBusyPercent: busyPercent(before, cpus()),
		loadAverage1m: Math.round(loadavg()[0] * 100) / 100,
		cores: before.length,
	});
}

const SAMPLE_FIELDS = [
	"keyToFrameP50Ms",
	"keyToFrameP95Ms",
	"keyToFrameMaxMs",
	"longTasks",
	"longTaskMs",
	"machineLoad",
	"passed",
];

/**
 * One result from repeated runs of a scenario: the timings of the run with
 * the lowest `metric`, since load from elsewhere on the machine only ever
 * slows a run down. Movement is not averaged away: the result fails when
 * any run moved. Every run's timings stay in `samples`.
 */
export function bestOfSamples(runs, metric = "keyToFrameP95Ms") {
	const measured = runs.filter((r) => typeof r[metric] === "number");
	if (measured.length === 0) return runs.find((r) => !r.error) ?? runs[0];
	const best = measured.toSorted((a, b) => a[metric] - b[metric])[0];
	const moved = runs.filter((r) => r.passed === false);
	const samples = runs.map((r) =>
		Object.fromEntries(
			[...SAMPLE_FIELDS, "error"].filter((k) => r[k] !== undefined).map((k) => [k, r[k]]),
		),
	);
	const values = measured.map((r) => r[metric]).join(" and ");
	const load = runs
		.map((r) => r.machineLoad?.cpuBusyPercent)
		.filter((v) => typeof v === "number")
		.map((v) => `${v}%`)
		.join(" and ");
	return {
		...best,
		passed: moved.length > 0 ? false : best.passed,
		moved: moved.length > 0 ? moved.flatMap((r) => r.moved ?? []) : best.moved,
		cls: Math.max(...runs.map((r) => r.cls ?? 0)),
		screenshots: runs.flatMap((r) => r.screenshots ?? []),
		samples,
		summary: `${best.summary}; best of ${runs.length} runs (p95 ${values} ms${load ? `, machine CPU busy ${load}` : ""})`,
	};
}
