import { Button as KumoButton } from "@cloudflare/kumo";
import type { Icon } from "@phosphor-icons/react";
import { createElement, forwardRef, isValidElement } from "react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils.js";
import { Spinner } from "./Spinner.js";

type KumoButtonProps = ComponentProps<typeof KumoButton>;

/** Keeps its content laid out, and in the accessible name, without drawing it. */
function Unpainted({ children }: { children: ReactNode }) {
	return <span className="contents text-transparent [&_*]:opacity-0">{children}</span>;
}

/**
 * Props for a Kumo button's loading state, for a control that forwards them to Kumo's `Button`,
 * such as `LayerDialog.Action`. Pass the button's children here rather than as JSX children.
 *
 * Kumo's own `loading` swaps the icon for its `Loader`, which changes the button's width, keeps
 * moving under reduced motion and announces itself inside the button. This keeps the icon and
 * label in place, undrawn, so the button keeps its size and accessible name, and draws a
 * {@link Spinner} over them. The button is disabled the same way.
 */
export function loadingButtonProps(
	loading: boolean | undefined,
	{
		disabled,
		icon,
		size,
		className,
		children,
	}: Pick<KumoButtonProps, "disabled" | "icon" | "size" | "className" | "children">,
) {
	if (!loading) return { disabled, icon, className, children };
	const spinner = (
		// Out of the flex layout, so it adds no gap. Kumo's primary and destructive buttons wrap
		// their content in a positioned span, which centers it over the content instead.
		<span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
			<Spinner size="sm" className={size === "lg" ? undefined : "size-3.5"} />
		</span>
	);
	// Kumo pads a button by whether it has an icon and whether it has text, so the spinner joins
	// whichever slot the button already fills.
	const iconNode = icon ? (isValidElement(icon) ? icon : createElement(icon as Icon)) : null;
	return {
		disabled: true,
		"aria-busy": true,
		// Kumo dims a button disabled by its `disabled` prop, but not one disabled while loading.
		className: cn("relative", !disabled && "opacity-100", className),
		icon: iconNode && (
			<>
				<Unpainted>{iconNode}</Unpainted>
				{spinner}
			</>
		),
		children: iconNode ? (
			children == null ? (
				children
			) : (
				<Unpainted>{children}</Unpainted>
			)
		) : (
			<>
				<Unpainted>{children}</Unpainted>
				{spinner}
			</>
		),
	};
}

/** Kumo's `Button`, with a `loading` state that keeps the button's size and holds still when motion is reduced. */
export const Button = forwardRef<HTMLButtonElement, KumoButtonProps>(function Button(
	{ loading, disabled, icon, size, className, children, ...props },
	ref,
) {
	return (
		<KumoButton
			{...props}
			{...loadingButtonProps(loading, { disabled, icon, size, className, children })}
			ref={ref}
			size={size}
		/>
	);
});
