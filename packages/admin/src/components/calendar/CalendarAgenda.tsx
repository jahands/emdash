import { Badge, Button, Empty } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CalendarBlank, CaretDown } from "@phosphor-icons/react";
import * as React from "react";

import {
	isMonthCutOff,
	shiftDay,
	type CalendarDisplay,
	type CalendarItem,
} from "../../lib/calendar.js";
import { cn } from "../../lib/utils.js";
import { CaretNext } from "../ArrowIcons.js";
import {
	CalendarDayList,
	CalendarDayListPlaceholder,
	CalendarNowLine,
	type CalendarSelectHandler,
} from "./CalendarEntry.js";

interface CalendarAgendaProps {
	month: string;
	days: ReadonlyMap<string, CalendarItem[]>;
	today: string;
	now: number;
	display: CalendarDisplay;
	loading?: boolean;
	/** The last day with loaded entries, when the range has more entries than were loaded. */
	loadedThrough?: string;
	/** Filters are hiding entries; the empty state offers to clear them. */
	onClearFilters?: () => void;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
}

/**
 * The month as a list of days. In the current month, days before today
 * start collapsed and a red line marks the present.
 */
export function CalendarAgenda({
	month,
	days,
	today,
	now,
	display,
	loading,
	loadedThrough,
	onClearFilters,
	selectedKey,
	onSelect,
}: CalendarAgendaProps) {
	const { t } = useLingui();
	const [showEarlier, setShowEarlier] = React.useState<boolean>();

	if (loading) return <CalendarAgendaSkeleton />;

	const cutOff = isMonthCutOff(month, loadedThrough);
	const keys = [...days.keys()].filter((day) => day.startsWith(month)).toSorted();
	if (keys.length === 0) {
		const monthTitle = display.monthTitle(month);
		return (
			<Empty
				size="sm"
				icon={<CalendarBlank size={32} aria-hidden="true" />}
				title={
					cutOff
						? onClearFilters
							? t`No loaded entries match these filters`
							: t`This month wasn't loaded`
						: onClearFilters
							? t`No entries match these filters`
							: t`Nothing published or scheduled in ${monthTitle}`
				}
				description={
					cutOff
						? t`The range has more entries than the calendar can show.`
						: onClearFilters
							? undefined
							: t`Scheduled entries appear here with their publish time.`
				}
				contents={
					onClearFilters ? (
						<Button variant="secondary" size="sm" onClick={onClearFilters}>
							{t`Clear filters`}
						</Button>
					) : undefined
				}
			/>
		);
	}

	const isCurrentMonth = today.startsWith(month);
	const earlier = isCurrentMonth ? keys.filter((day) => day < today) : [];
	const earlierCount = earlier.reduce((count, day) => count + (days.get(day)?.length ?? 0), 0);
	// Earlier days start expanded while one of them holds an overdue entry.
	const expanded =
		showEarlier ?? earlier.some((day) => days.get(day)?.some((item) => item.state === "overdue"));
	const shown = expanded || !isCurrentMonth ? keys : keys.filter((day) => day >= today);

	const todayItems = isCurrentMonth ? days.get(today) : undefined;
	const firstUpcoming = todayItems?.findIndex((item) => item.time > now) ?? -1;
	const nowAt = todayItems && (firstUpcoming === -1 ? todayItems.length : firstUpcoming);
	const nextDay = isCurrentMonth && !todayItems ? shown.find((day) => day > today) : undefined;
	const nothingAfterNow =
		isCurrentMonth &&
		!cutOff &&
		!keys.some((day) => days.get(day)?.some((item) => item.time > now));
	const time = display.formatTime(now);
	const standaloneNowLine = <CalendarNowLine label={t`Now · ${time}`} className="px-2" />;
	const tomorrow = shiftDay(today, 1);

	return (
		<div className="grid gap-6">
			{earlierCount > 0 && (
				<Button
					variant="ghost"
					size="sm"
					className="justify-self-start text-kumo-subtle"
					aria-expanded={expanded}
					icon={expanded ? <CaretDown aria-hidden="true" /> : <CaretNext aria-hidden="true" />}
					onClick={() => setShowEarlier(!expanded)}
				>
					{expanded
						? t`Hide earlier entries`
						: plural(earlierCount, {
								one: "Show # earlier entry",
								other: "Show # earlier entries",
							})}
				</Button>
			)}
			{shown.map((day) => (
				<React.Fragment key={day}>
					{day === nextDay && standaloneNowLine}
					<CalendarAgendaDay
						day={day}
						items={days.get(day) ?? []}
						relative={day === today ? "today" : day === tomorrow ? "tomorrow" : undefined}
						nowAt={day === today ? nowAt : undefined}
						now={now}
						display={display}
						selectedKey={selectedKey}
						onSelect={onSelect}
					/>
				</React.Fragment>
			))}
			{isCurrentMonth && !todayItems && !nextDay && standaloneNowLine}
			{nothingAfterNow && (
				<p className="px-2 text-sm text-kumo-subtle">{t`Nothing else is scheduled this month.`}</p>
			)}
			{cutOff && (
				<p className="px-2 text-sm text-kumo-subtle">
					{t`Later entries weren't loaded. The range has more entries than the calendar can show.`}
				</p>
			)}
		</div>
	);
}

interface CalendarAgendaDayProps {
	day: string;
	items: readonly CalendarItem[];
	relative?: "today" | "tomorrow";
	nowAt?: number;
	now: number;
	display: CalendarDisplay;
	selectedKey?: string;
	onSelect?: CalendarSelectHandler;
}

function CalendarAgendaDay({
	day,
	items,
	relative,
	nowAt,
	now,
	display,
	selectedKey,
	onSelect,
}: CalendarAgendaDayProps) {
	const { t } = useLingui();
	const headingId = React.useId();

	return (
		<section aria-labelledby={headingId}>
			<h3
				id={headingId}
				className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-kumo-line bg-kumo-elevated px-2 pt-2 pb-2 text-base before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-6 before:bg-kumo-elevated"
			>
				<span className="font-semibold text-kumo-default">{display.weekday(day)}</span>
				<span className="text-kumo-subtle">{display.monthDay(day)}</span>
				{relative === "today" && (
					<Badge variant="red" className="self-center">
						{t`Today`}
					</Badge>
				)}
				{relative === "tomorrow" && (
					<Badge variant="secondary" className="self-center">
						{t`Tomorrow`}
					</Badge>
				)}
			</h3>
			<CalendarDayList
				items={items}
				display={display}
				now={now}
				label={display.fullDate(day)}
				nowAt={nowAt}
				selectedKey={selectedKey}
				onSelect={onSelect}
				className="mt-1"
			/>
		</section>
	);
}

const PLACEHOLDER_DAYS = [
	{ rows: 2, headingWidth: "w-36" },
	{ rows: 1, headingWidth: "w-32" },
	{ rows: 3, headingWidth: "w-40" },
];

/** Days shaped like `CalendarAgendaDay`, in the agenda's own spacing. */
function CalendarAgendaSkeleton() {
	return (
		<div aria-hidden="true" className="grid gap-6">
			{PLACEHOLDER_DAYS.map(({ rows, headingWidth }, day) => (
				<div key={day}>
					<div className="border-b border-kumo-line px-2 pt-2 pb-2 text-base">
						<div className="flex h-lh items-center">
							<div className={cn("skeleton-line", headingWidth)} />
						</div>
					</div>
					<CalendarDayListPlaceholder rows={rows} className="mt-1" />
				</div>
			))}
		</div>
	);
}
