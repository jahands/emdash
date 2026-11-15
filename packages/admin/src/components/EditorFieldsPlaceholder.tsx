import { SkeletonLine } from "@cloudflare/kumo";

// Fixed widths: the editor's frame and the editor show these lines one after
// the other, and SkeletonLine picks a new width on each mount from a range.
const BODY_LINE_WIDTHS = [92, 100, 85, 96, 78, 64];

/** Lines in the shape of an entry's title and body, shown while its fields load. */
export function EditorFieldsPlaceholder() {
	return (
		<div className="space-y-4" aria-hidden="true">
			<SkeletonLine blockHeight={36} minWidth={55} maxWidth={55} />
			{BODY_LINE_WIDTHS.map((width, index) => (
				<SkeletonLine key={index} blockHeight={16} minWidth={width} maxWidth={width} />
			))}
		</div>
	);
}
