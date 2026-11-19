import * as React from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { useRevisionView } from "../../../src/components/revisions/useRevisionView";
import type { RevisionListItem } from "../../../src/lib/api";
import type { DiffFieldDescriptor } from "../../../src/lib/revision-diff/types.js";
import { render } from "../../utils/render.tsx";

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return { ...actual, fetchRevisions: vi.fn(), compareRevisions: vi.fn() };
});

import { compareRevisions, fetchRevisions } from "../../../src/lib/api";

const FIELDS: Record<string, DiffFieldDescriptor> = { title: { kind: "string", label: "Title" } };

/** How tall each version draws in a 200px canvas. The editor is 1000px tall. */
const HEIGHTS: Record<string, number> = { "rev-3": 1000, "rev-2": 1000, "rev-1": 250 };

function revision(id: string, title: string, createdAt: string): RevisionListItem {
	return {
		id,
		collection: "posts",
		entryId: "entry-1",
		data: { title },
		authorId: "u-maya",
		author: { id: "u-maya", name: "Maya Chen" },
		createdAt,
	};
}

/** Takes its full height a moment after mounting, as the rich text editor's blocks do. */
function EditorPage() {
	const [drawn, setDrawn] = React.useState(false);
	React.useEffect(() => queueMicrotask(() => setDrawn(true)), []);
	return <div style={{ height: drawn ? 1000 : 100 }} />;
}

function Editor() {
	const canvasRef = React.useRef<HTMLDivElement>(null);
	const [editorGeneration, setEditorGeneration] = React.useState(0);
	const view = useRevisionView({
		collection: "posts",
		entryId: "entry-1",
		locale: "en",
		enabled: true,
		draftRevisionId: "rev-3",
		liveRevisionId: null,
		fields: FIELDS,
		listVisible: true,
		canvasRef,
	});
	const viewing = view.viewingId !== null;
	const shown = view.revision?.id;
	return (
		<>
			{Object.keys(HEIGHTS).map((id) => (
				<button key={id} type="button" onClick={() => view.view(id)}>
					View {id}
				</button>
			))}
			<button type="button" onClick={view.exit}>
				Back to editing
			</button>
			<button
				type="button"
				onClick={() => {
					view.beginRestore({ draftRevisionId: "rev-4" });
					view.completeRestore();
					setEditorGeneration((generation) => generation + 1);
				}}
			>
				Restored
			</button>
			<output>{shown ? `Showing ${shown}` : viewing ? "Loading" : "Editing"}</output>
			<div ref={canvasRef} data-testid="canvas" style={{ height: 200, overflowY: "auto" }}>
				<div hidden={viewing}>
					<EditorPage key={editorGeneration} />
				</div>
				{/* A version that hasn't loaded yet draws a short loader. */}
				{viewing && <div style={{ height: shown ? HEIGHTS[shown] : 100 }} />}
			</div>
		</>
	);
}

async function renderEditor() {
	const screen = await render(<Editor />);
	const canvas = screen.getByTestId("canvas").element();
	await expect.poll(() => canvas.scrollHeight).toBeGreaterThanOrEqual(1000);
	const open = async (id: string) => {
		await screen.getByRole("button", { name: `View ${id}` }).click();
		await expect.element(screen.getByText(`Showing ${id}`)).toBeInTheDocument();
	};
	return { screen, canvas, open };
}

beforeEach(() => {
	vi.resetAllMocks();
	(fetchRevisions as Mock).mockResolvedValue({
		items: [
			revision("rev-3", "Third", "2026-10-03 12:00:00"),
			revision("rev-2", "Second", "2026-10-02 12:00:00"),
			revision("rev-1", "First", "2026-10-01 12:00:00"),
		],
		total: 3,
	});
});

describe("useRevisionView", () => {
	it("keeps the canvas where it was scrolled from the editor through each version", async () => {
		const { screen, canvas, open } = await renderEditor();
		canvas.scrollTop = 300;

		await open("rev-2");
		expect(canvas.scrollTop).toBe(300);

		await open("rev-1");
		expect(canvas.scrollTop).toBe(50);

		await open("rev-3");
		expect(canvas.scrollTop).toBe(300);

		canvas.scrollTop = 120;
		await open("rev-2");
		expect(canvas.scrollTop).toBe(120);

		await screen.getByRole("button", { name: "Back to editing" }).click();
		await expect.element(screen.getByText("Editing", { exact: true })).toBeInTheDocument();
		expect(canvas.scrollTop).toBe(300);
	});

	it("leaves a restored version where it was scrolled once the editor has drawn", async () => {
		const { screen, canvas, open } = await renderEditor();
		await open("rev-2");
		canvas.scrollTop = 500;

		await screen.getByRole("button", { name: "Restored" }).click();
		await expect.element(screen.getByText("Editing", { exact: true })).toBeInTheDocument();
		await expect.poll(() => canvas.scrollTop).toBe(500);
	});
});

function DraftChanges() {
	const canvasRef = React.useRef<HTMLDivElement>(null);
	const view = useRevisionView({
		collection: "posts",
		entryId: "entry-1",
		locale: "en",
		enabled: true,
		draftRevisionId: "rev-30",
		liveRevisionId: "rev-1",
		fields: FIELDS,
		listVisible: true,
		canvasRef,
	});
	return (
		<>
			<button type="button" onClick={() => view.context.viewDraftChanges()}>
				View changes
			</button>
			<button type="button" onClick={() => view.context.showOlderVersions()}>
				Show older versions
			</button>
			<output>{view.diff ? "Compared" : "Loading"}</output>
			<div ref={canvasRef} />
		</>
	);
}

describe("useRevisionView's comparison with the live version", () => {
	it("isn't read again when showing older versions first lists the live one", async () => {
		const all = Array.from({ length: 30 }, (_, index) =>
			revision(
				`rev-${30 - index}`,
				`Version ${30 - index}`,
				`2026-10-01 12:${String(59 - index).padStart(2, "0")}:00`,
			),
		);
		(fetchRevisions as Mock).mockImplementation(
			async (_collection: string, _entry: string, options?: { limit?: number }) => ({
				items: all.slice(0, options?.limit ?? all.length),
				total: all.length,
			}),
		);
		(compareRevisions as Mock).mockResolvedValue({
			hasChanges: true,
			live: { title: "Version 1" },
			draft: { title: "Version 30" },
		});
		const screen = await render(<DraftChanges />);

		await screen.getByRole("button", { name: "View changes" }).click();
		await expect.element(screen.getByText("Compared")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Show older versions" }).click();
		await expect.poll(() => (fetchRevisions as Mock).mock.calls.length).toBeGreaterThan(1);
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(compareRevisions).toHaveBeenCalledOnce();
	});
});
