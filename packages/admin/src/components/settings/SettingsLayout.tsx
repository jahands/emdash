import { Field, Input, SkeletonLine } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import { cn } from "../../lib/utils.js";
import { CaretNext } from "../ArrowIcons.js";
import { EditorHeader } from "../EditorHeader.js";
import { SaveButton } from "../SaveButton.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

interface SettingsFrameProps {
	title: React.ReactNode;
	description: React.ReactNode;
	actions?: React.ReactNode;
	/** The page's sections are in outline while its settings load. */
	loading?: boolean;
	children: React.ReactNode;
}

export function SettingsFrame({
	title,
	description,
	actions,
	loading = false,
	children,
}: SettingsFrameProps) {
	const { t } = useLingui();
	return (
		<div className="max-w-4xl pb-6">
			<EditorHeader
				leading={
					<div className="self-start">
						<BackToSettingsLink />
					</div>
				}
				actions={actions}
			>
				<div>
					<h1 className="text-2xl font-semibold leading-tight text-balance">{title}</h1>
					<p className="mt-1.5 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
						{description}
					</p>
				</div>
			</EditorHeader>
			<div className="mt-6">
				{loading && (
					<span role="status" className="sr-only">
						{t`Loading settings...`}
					</span>
				)}
				{children}
			</div>
		</div>
	);
}

/**
 * Takes the space of a page's Save button while its settings load, so the
 * header doesn't change height when the button appears.
 */
export function PendingSaveAction() {
	return (
		<div className="invisible" aria-hidden="true" inert>
			<SaveButton isDirty={false} isSaving={false} announce={false} />
		</div>
	);
}

interface SettingsFieldPlaceholderProps {
	label: React.ReactNode;
	description?: React.ReactNode;
	/** The height of the control it stands in for. */
	controlClassName?: string;
}

/**
 * A field whose value is loading: its label and description around a block the size of
 * the input that replaces it.
 */
export function SettingsFieldPlaceholder({
	label,
	description,
	controlClassName = "h-9",
}: SettingsFieldPlaceholderProps) {
	return (
		<Field label={label} description={description}>
			<div aria-hidden="true" className={cn("skeleton-line w-full rounded-lg", controlClassName)} />
		</Field>
	);
}

/** An `Input` that keeps its label and description around a placeholder while `loading`. */
export function SettingsInput({
	loading,
	...props
}: React.ComponentProps<typeof Input> & { loading: boolean }) {
	if (!loading) return <Input {...props} />;
	return <SettingsFieldPlaceholder label={props.label} description={props.description} />;
}

// Fixed, so the outline keeps its shape if the page remounts while loading.
const PLACEHOLDER_ROW_WIDTHS = [
	[42, 64],
	[30, 52],
	[48, 38],
] as const;

/** Rows of a settings list whose items are loading, each a name and a line of details. */
export function SettingsPlaceholderRows({ rows = 2 }: { rows?: number }) {
	return Array.from({ length: rows }, (_, row) => {
		const [name, details] = PLACEHOLDER_ROW_WIDTHS[row % PLACEHOLDER_ROW_WIDTHS.length]!;
		return (
			<SettingRow key={row}>
				<div aria-hidden="true">
					<SkeletonLine blockHeight={20} minWidth={name} maxWidth={name} />
					<SkeletonLine blockHeight={20} minWidth={details} maxWidth={details} />
				</div>
			</SettingRow>
		);
	});
}

interface SettingsSectionProps {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	contentClassName?: string;
	children: React.ReactNode;
}

export function SettingsSection({
	title,
	description,
	actions,
	contentClassName,
	children,
}: SettingsSectionProps) {
	const headingId = React.useId();

	return (
		<section aria-labelledby={headingId}>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="grid gap-1">
					<h2 id={headingId} className="text-lg font-semibold leading-6 text-balance">
						{title}
					</h2>
					{description && (
						<p className="max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
							{description}
						</p>
					)}
				</div>
				{actions && <div className="flex shrink-0 justify-end sm:pt-0.5">{actions}</div>}
			</div>
			<div
				className={cn(
					"mt-3 divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base",
					contentClassName,
				)}
			>
				{children}
			</div>
		</section>
	);
}

interface SettingRowProps {
	children: React.ReactNode;
	className?: string;
}

export function SettingRow({ children, className }: SettingRowProps) {
	return <div className={cn("px-4 py-4", className)}>{children}</div>;
}

interface SettingsNavRowProps {
	to: string;
	icon: React.ReactNode;
	title: React.ReactNode;
	description: React.ReactNode;
}

export function SettingsNavRow({ to, icon, title, description }: SettingsNavRowProps) {
	return (
		<Link
			to={to}
			className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-kumo-tint focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand"
		>
			<span
				className="flex h-5 w-5 shrink-0 items-center justify-center text-kumo-subtle"
				aria-hidden="true"
			>
				{icon}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block text-base font-medium leading-5">{title}</span>
				<span className="mt-0.5 block text-sm leading-5 text-pretty text-kumo-subtle">
					{description}
				</span>
			</span>
			<CaretNext
				className="h-5 w-5 shrink-0 text-kumo-subtle rtl:-scale-x-100"
				aria-hidden="true"
			/>
		</Link>
	);
}
