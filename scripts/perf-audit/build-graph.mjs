import { gzipSync } from "node:zlib";

export function auditBuildGraph() {
	return {
		name: "perf-audit-initial-js",
		apply: "build",
		generateBundle(_options, bundle) {
			const graph = {};
			for (const [file, chunk] of Object.entries(bundle)) {
				if (chunk.type === "chunk")
					graph[file] = { imports: chunk.imports, gzipBytes: gzipSync(chunk.code).length };
			}
			this.emitFile({
				type: "asset",
				fileName: "perf-initial-js.json",
				source: JSON.stringify(graph),
			});
		},
	};
}

export function initialJsBytes(graph, entries) {
	const visited = new Set();
	function visit(file) {
		if (visited.has(file)) return 0;
		const chunk = graph[file];
		if (!chunk) throw new Error(`Initial JS entry missing from production graph: ${file}`);
		visited.add(file);
		return chunk.gzipBytes + chunk.imports.reduce((sum, dependency) => sum + visit(dependency), 0);
	}
	return entries.reduce((sum, file) => sum + visit(file), 0);
}
