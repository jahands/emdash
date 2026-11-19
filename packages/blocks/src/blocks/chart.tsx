import { lazy, Suspense } from "react";

import type { ChartBlock } from "../types.js";

const DEFAULT_CHART_HEIGHT = 350;

const EChartsChart = lazy(() => import("./echarts-chart.js"));

export function ChartBlockComponent({ block }: { block: ChartBlock }) {
	return (
		<div className="rounded-lg border border-kumo-line p-4">
			<Suspense fallback={<div style={{ height: block.config.height ?? DEFAULT_CHART_HEIGHT }} />}>
				<EChartsChart block={block} />
			</Suspense>
		</div>
	);
}
