import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, CloudSlash, CloudWarning, FloppyDisk } from "@phosphor-icons/react";
import { forwardRef, isValidElement } from "react";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils";
import type { SyncProblem } from "./co-editing/SyncStatus";

type SyncKind = SyncProblem["kind"];
type SaveState = "save" | "saving" | "saved" | SyncKind;

export interface SaveButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "shape"> {
	isDirty: boolean;
	isSaving: boolean;
	announce?: boolean;
	/** Classes for the visible label, e.g. to hide it on small screens and keep only the icon. */
	labelClassName?: string;
	/** Replaces the "Save" label, e.g. "Save draft". */
	saveLabel?: string;
	/**
	 * A co-editing problem to show instead of the save state. The button then stays enabled, to
	 * explain the problem. Set it, to a kind or null, wherever the button can show one, so the
	 * button keeps one width across every state.
	 */
	sync?: SyncKind | null;
}

export const SaveButton = forwardRef<HTMLButtonElement, SaveButtonProps>(function SaveButton(
	{
		isDirty,
		isSaving,
		announce = true,
		labelClassName,
		saveLabel: customSaveLabel,
		sync,
		className,
		disabled,
		icon,
		loading,
		variant,
		inert,
		"aria-label": ariaLabel,
		...props
	},
	ref,
) {
	const { t } = useLingui();
	const labels: Record<SaveState, string> = {
		save: customSaveLabel ?? t`Save`,
		saving: t`Saving...`,
		saved: t`Saved`,
		joining: t`Joining…`,
		offline: t`Offline`,
		"not-saved": t`Not saved`,
		"not-kept": t`Not saved`,
	};
	const isBusy = isSaving || Boolean(loading);
	const activeState: SaveState = sync ? sync : isBusy ? "saving" : isDirty ? "save" : "saved";
	const activeLabel = labels[activeState];
	const stateIds: SaveState[] =
		sync === undefined
			? ["save", "saving", "saved"]
			: ["save", "saving", "saved", "joining", "offline", "not-saved", "not-kept"];
	const stateIcon = (state: SaveState) =>
		state === "save" ? (
			isValidElement(icon) ? (
				icon
			) : (
				<FloppyDisk />
			)
		) : state === "saving" || state === "joining" ? (
			<Loader size="sm" />
		) : state === "offline" ? (
			<CloudSlash />
		) : state === "not-saved" || state === "not-kept" ? (
			<CloudWarning />
		) : (
			<Check />
		);
	const states = stateIds.map((id) => ({ id, label: labels[id], icon: stateIcon(id) }));

	return (
		<Button
			{...props}
			ref={ref}
			inert={inert}
			className={cn("min-w-[100px] justify-center", className)}
			disabled={sync ? disabled : disabled || !isDirty || isBusy}
			variant={variant ?? ((isDirty || isBusy) && !sync ? "primary" : "secondary")}
			aria-label={ariaLabel ?? activeLabel}
			aria-busy={isBusy}
		>
			<span
				data-save-button-labels=""
				className="inline-grid items-center justify-items-center"
				aria-hidden="true"
			>
				{states.map((state) => (
					<span
						key={state.id}
						data-save-button-state={state.id}
						style={{ gridArea: "1 / 1" }}
						className={cn(
							"inline-flex items-center justify-center gap-1.5 leading-none",
							!inert &&
								"transition-[opacity,visibility] duration-150 ease-in-out motion-reduce:transition-none",
							state.id === activeState ? "visible opacity-100" : "invisible opacity-0",
							(state.id === "not-saved" || state.id === "not-kept") && "text-kumo-warning",
						)}
					>
						{state.icon}
						<span className={labelClassName}>{state.label}</span>
					</span>
				))}
			</span>
			<span
				className="sr-only"
				role={announce ? "status" : undefined}
				aria-live={announce ? "polite" : undefined}
				aria-atomic={announce || undefined}
			>
				{activeLabel}
			</span>
		</Button>
	);
});

export default SaveButton;
