import { plural } from "@lingui/core/macro";

import { useAnnouncePresence, usePresence } from "../../lib/realtime/LiveSyncProvider.js";
import { PresenceFaces } from "./PresenceFaces.js";

/**
 * Tells others this tab is on a screen that has no co-editing room, and shows who else is. A
 * screen with unsaved changes says it is editing, so others know a save of theirs may conflict.
 */
export function ScreenPresence({ topic, editing }: { topic: string; editing: boolean }) {
	useAnnouncePresence(topic, editing ? "editing" : "viewing");
	const people = usePresence(topic);
	return (
		<PresenceFaces
			people={people}
			label={plural(people.length, {
				one: "# other person here",
				other: "# other people here",
			})}
			ringClassName="ring-kumo-elevated"
			focusable
		/>
	);
}
