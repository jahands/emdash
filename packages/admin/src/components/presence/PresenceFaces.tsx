import { Tooltip } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { PresentPerson } from "../../lib/realtime/LiveSyncProvider.js";
import { cn } from "../../lib/utils.js";
import { initials } from "./presence-format.js";

const CIRCLE =
	"flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-semibold ring-2 select-none";
const FACE = "bg-(--emdash-author) text-(color:--emdash-author-text)";

/**
 * Who else is here, from the realtime hub: up to `max` circles, or one fewer and "+N", with
 * everyone's name and activity in a tooltip. With `max` 1 and more people, one circle counts
 * them. Nothing renders while no one else is here.
 */
export function PresenceFaces({
	people,
	label,
	max = 3,
	ringClassName,
	focusable = false,
	className,
}: {
	people: readonly PresentPerson[];
	/** The accessible name, which screen readers hear in place of the circles. */
	label: string;
	max?: number;
	/** The ring that cuts overlapping circles apart, in the color behind them. */
	ringClassName: string;
	/** Whether keyboard users can reach the tooltip. Off inside rows, whose controls are counted. */
	focusable?: boolean;
	className?: string;
}) {
	const { t } = useLingui();
	if (people.length === 0) return null;
	const faces = people.length > max ? people.slice(0, max - 1) : people;
	const more = people.length - faces.length;
	const describe = ({ name, activity }: PresentPerson) =>
		activity === "editing" ? t`${name} · Editing` : t`${name} · Viewing`;

	return (
		<Tooltip
			content={
				<ul>
					{people.map((person) => (
						<li key={`${person.topic}:${person.id}`} dir="auto">
							{describe(person)}
						</li>
					))}
				</ul>
			}
			render={
				<span
					role="img"
					aria-label={label}
					tabIndex={focusable ? 0 : undefined}
					className={cn("flex items-center rounded-full", className)}
				>
					{faces.map((person, index) => (
						<span
							key={`${person.topic}:${person.id}`}
							data-author-color={person.color}
							aria-hidden="true"
							className={cn(CIRCLE, FACE, ringClassName, index > 0 && "-ms-1")}
						>
							<span dir="auto">{initials(person.name)}</span>
						</span>
					))}
					{more > 0 && (
						<span
							aria-hidden="true"
							className={cn(CIRCLE, ringClassName, "bg-kumo-fill", faces.length > 0 && "-ms-1")}
						>
							<span dir="ltr">{faces.length > 0 ? t`+${more}` : people.length}</span>
						</span>
					)}
				</span>
			}
		/>
	);
}
