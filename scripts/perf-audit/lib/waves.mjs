/**
 * Count sequential "waves" in a set of time intervals: the length of the
 * longest chain where each interval starts only after the previous one
 * ended. Requests issued together form one wave; a request that had to wait
 * for another's response starts the next one. For database queries this is
 * the number of round trips a request paid for in sequence.
 */
export function computeWaves(intervals, { toleranceMs = 0 } = {}) {
	const sorted = intervals
		.map((interval, index) => ({ ...interval, index }))
		.toSorted((a, b) => a.start - b.start || a.end - b.end);
	const wave = Array.from({ length: sorted.length }).fill(1);
	for (let i = 0; i < sorted.length; i++) {
		for (let j = 0; j < i; j++) {
			if (sorted[j].end <= sorted[i].start + toleranceMs && wave[j] + 1 > wave[i]) {
				wave[i] = wave[j] + 1;
			}
		}
	}
	const assignments = Array.from({ length: intervals.length });
	sorted.forEach((interval, i) => {
		assignments[interval.index] = wave[i];
	});
	return { waves: sorted.length === 0 ? 0 : Math.max(...wave), assignments };
}
