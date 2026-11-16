import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { EditorActions, type EditorActionsProps } from "../../src/components/ContentSettingsPanel";
import { render } from "../utils/render.tsx";

function props(overrides: Partial<EditorActionsProps> = {}): EditorActionsProps {
	return {
		collectionLabel: "Post",
		isDirty: false,
		isSaving: false,
		isLive: true,
		hasPendingChanges: false,
		liveViewUrl: null,
		supportsPreview: false,
		isLoadingPreview: false,
		onPreview: vi.fn(),
		onPublish: vi.fn(),
		onUnpublish: vi.fn(),
		...overrides,
	};
}

describe("EditorActions save status", () => {
	it("reports automatic saves as Saving and Saved, keeping one look throughout", async () => {
		const automatic = props({ savesAutomatically: true });
		const screen = await render(<EditorActions {...automatic} />);
		const shown = async () => {
			// Lets the label and color transitions finish.
			await new Promise((resolve) => setTimeout(resolve, 300));
			const button = screen.container.querySelector("[data-save-button-labels]")!.closest("button")!;
			const style = getComputedStyle(button);
			return {
				label: button.querySelector("[data-save-button-state].visible")?.textContent,
				look: [style.color, style.backgroundColor, style.boxShadow, style.opacity].join(" | "),
				hidden: button.closest(".invisible") !== null,
			};
		};

		const clean = await shown();
		await screen.rerender(<EditorActions {...automatic} isDirty />);
		const waiting = await shown();
		await screen.rerender(<EditorActions {...automatic} isDirty isAutosaving />);
		const sending = await shown();
		await screen.rerender(<EditorActions {...automatic} />);
		const saved = await shown();
		const states = [clean, waiting, sending, saved];

		expect(states.map((state) => state.label)).toEqual(["Saved", "Saving...", "Saving...", "Saved"]);
		expect(new Set(states.map((state) => state.look)).size).toBe(1);
		expect(states.some((state) => state.hidden)).toBe(false);
	});

	it("asks for a save after edits that don't save automatically", async () => {
		const screen = await render(<EditorActions {...props({ isDirty: true })} />);

		await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	});
});
