export function mergeDocuments(documents) {
	if (!documents.length) return null;
	documents = documents.toSorted((a, b) => a.timeOrigin - b.timeOrigin);
	const origin = Math.min(...documents.map((document) => document.timeOrigin));
	const merged = {
		...documents.at(-1),
		paints: documents[0].paints,
		shifts: [],
		timeline: [],
		longTasks: [],
		largestPaints: [],
		events: [],
	};
	for (const document of documents) {
		for (const key of ["shifts", "timeline", "longTasks", "largestPaints", "events"]) {
			merged[key].push(
				...(document[key] ?? []).map((entry) => ({
					...entry,
					documentId: document.documentId,
					t: entry.t + document.timeOrigin - origin,
				})),
			);
		}
	}
	return merged;
}
