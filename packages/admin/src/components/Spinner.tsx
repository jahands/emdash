import { CircleNotch } from "@phosphor-icons/react";

import { cn } from "../lib/utils.js";

const SIZES = { sm: 16, base: 24, lg: 32 } as const;

/**
 * Decorative spinner for a control's own action, a long operation's progress, or a refetch in a
 * reserved slot. It never announces: the surrounding region owns the status. Use it instead of
 * Kumo's `Loader`, which renders its own `role="status"` and ignores reduced motion.
 */
export function Spinner({
	size = "base",
	className,
}: {
	size?: keyof typeof SIZES;
	className?: string;
}) {
	return (
		<CircleNotch
			aria-hidden="true"
			size={SIZES[size]}
			className={cn("shrink-0 animate-spin motion-reduce:animate-none", className)}
		/>
	);
}
