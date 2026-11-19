/**
 * The images a run uploads. Sizes cover the range real sites upload: camera
 * photos up to 4000px and retina screenshots. Seeds make every run draw the
 * same pixels.
 */
export const MEDIA_SPECS = [
	{
		kind: "photo",
		seed: 101,
		width: 4000,
		height: 2667,
		filename: "perf-lake-dawn.jpg",
		alt: "A lake under a dawn sky with layered hills",
	},
	{
		kind: "photo",
		seed: 202,
		width: 3200,
		height: 2400,
		filename: "perf-ridge-noon.jpg",
		alt: "A mountain ridge at midday",
	},
	{
		kind: "photo",
		seed: 303,
		width: 2400,
		height: 1600,
		filename: "perf-valley-dusk.jpg",
		alt: "A valley at dusk",
	},
	{
		kind: "photo",
		seed: 404,
		width: 1600,
		height: 2000,
		filename: "perf-forest-portrait.jpg",
		alt: "A forest path in portrait orientation",
	},
	{
		kind: "photo",
		seed: 505,
		width: 3000,
		height: 2000,
		filename: "perf-coast-haze.jpg",
		alt: "A hazy coastline",
	},
	{
		kind: "photo",
		seed: 606,
		width: 2048,
		height: 1536,
		filename: "perf-meadow.jpg",
		alt: "A meadow below rolling hills",
	},
	{
		kind: "screenshot",
		seed: 707,
		width: 2880,
		height: 1800,
		filename: "perf-dashboard.png",
		alt: "A dashboard screenshot with charts and a table",
	},
	{
		kind: "screenshot",
		seed: 808,
		width: 2560,
		height: 1600,
		filename: "perf-settings.png",
		alt: "A settings screen screenshot",
	},
	{
		kind: "screenshot",
		seed: 909,
		width: 1920,
		height: 1200,
		filename: "perf-editor.png",
		alt: "An editor screenshot with a sidebar",
	},
	{
		kind: "screenshot",
		seed: 1010,
		width: 1600,
		height: 1000,
		filename: "perf-report.png",
		alt: "A report screenshot with a line chart",
	},
];

export const MIN_UPLOAD_BYTES = 512 * 1024;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
