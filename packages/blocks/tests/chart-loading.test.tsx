import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "../src/renderer.js";

const echarts = vi.hoisted(() => ({ loaded: false }));

vi.mock("echarts/core", () => {
	echarts.loaded = true;
	const noop = () => {};
	return { __esModule: true, default: { use: noop }, use: noop };
});

vi.mock("echarts/charts", () => ({ BarChart: {}, LineChart: {}, PieChart: {} }));

vi.mock("echarts/components", () => ({
	AriaComponent: {},
	AxisPointerComponent: {},
	BrushComponent: {},
	GridComponent: {},
	ToolboxComponent: {},
	TooltipComponent: {},
}));

vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));

vi.mock("@cloudflare/kumo/components/chart", () => ({
	TimeseriesChart: (props: { height?: number }) => (
		<div data-testid="timeseries-chart" data-height={props.height} />
	),
	Chart: () => <div data-testid="custom-chart" />,
	ChartPalette: { categorical: (i: number) => `#color${i}` },
}));

afterEach(cleanup);

describe("chart block loading", () => {
	it("loads echarts only once a chart block renders", async () => {
		vi.stubGlobal("matchMedia", () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		}));

		render(<BlockRenderer blocks={[{ type: "header", text: "Stats" }]} onAction={vi.fn()} />);
		expect(screen.getByText("Stats")).toBeTruthy();
		expect(echarts.loaded).toBe(false);

		render(
			<BlockRenderer
				blocks={[
					{
						type: "chart",
						config: {
							chart_type: "timeseries",
							style: "line",
							height: 240,
							series: [{ name: "Views", data: [[1_700_000_000_000, 3]] }],
						},
					},
				]}
				onAction={vi.fn()}
			/>,
		);

		const chart = await screen.findByTestId("timeseries-chart");
		expect(chart.dataset.height).toBe("240");
		expect(echarts.loaded).toBe(true);

		vi.unstubAllGlobals();
	});
});
