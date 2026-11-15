import { Button as KumoButton } from "@cloudflare/kumo";
import { forwardRef } from "react";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils.js";
import { Spinner } from "./Spinner.js";

type KumoButtonProps = ComponentProps<typeof KumoButton>;

/**
 * Props for a Kumo button's loading state, for a control that forwards them to Kumo's `Button`,
 * such as `LayerDialog.Action`. Kumo's own `loading` draws its `Loader`, which keeps moving under
 * reduced motion and announces itself inside the button, so this swaps in {@link Spinner} at the
 * Loader's size and keeps the button disabled the same way.
 */
export function loadingButtonProps(
	loading: boolean | undefined,
	{ disabled, icon, size }: Pick<KumoButtonProps, "disabled" | "icon" | "size">,
) {
	if (!loading) return { disabled, icon };
	return {
		disabled: true,
		icon: <Spinner size="sm" className={size === "lg" ? undefined : "size-3.5"} />,
		"aria-busy": true,
	};
}

/** Kumo's `Button`, with a `loading` state that holds still when motion is reduced. */
export const Button = forwardRef<HTMLButtonElement, KumoButtonProps>(function Button(
	{ loading, disabled, icon, size, className, ...props },
	ref,
) {
	return (
		<KumoButton
			{...props}
			{...loadingButtonProps(loading, { disabled, icon, size })}
			ref={ref}
			size={size}
			// Kumo dims a button disabled by its `disabled` prop, but not one disabled while loading.
			className={cn(loading && !disabled && "opacity-100", className)}
		/>
	);
});
