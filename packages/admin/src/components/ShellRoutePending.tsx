import { SkeletonLine } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { useMatch } from "@tanstack/react-router";

import { fetchManifest } from "../lib/api";
import { ArrowPrev } from "./ArrowIcons.js";
import { EditorFieldsPlaceholder } from "./EditorFieldsPlaceholder.js";
import { EditorHeader } from "./EditorHeader.js";
import { RouterLinkButton } from "./RouterLinkButton.js";
import { BackToSettingsLink } from "./settings/BackToSettingsLink.js";
import { PendingSaveAction } from "./settings/SettingsLayout.js";
import { useRouteSubjectLabel } from "./ShellRouteSubject.js";

type Params = Record<string, string | undefined>;

function useManifest() {
	return useQuery({ queryKey: ["manifest"], queryFn: fetchManifest }).data;
}

/** The pending route's match, or none outside a route. */
function usePendingMatch() {
	return useMatch({ strict: false, shouldThrow: false });
}

function TitlePlaceholder({ height }: { height: number }) {
	return (
		<div className="w-48" aria-hidden="true">
			<SkeletonLine blockHeight={height} minWidth={100} maxWidth={100} className="h-5 rounded" />
		</div>
	);
}

/** A screen's title, where the screen shows it, while the screen's code loads. */
export function RoutePending() {
	const { t } = useLingui();
	const match = usePendingMatch();
	const manifest = useManifest();
	const params: Params = match?.params ?? {};
	const subjectLabel = useRouteSubjectLabel(manifest, params);
	const heading = match?.staticData?.heading ?? match?.staticData?.pageTitle;
	// Other params name a record, whose name is the screen's heading.
	const title =
		subjectLabel ?? (heading && Object.keys(params).length === 0 ? t(heading) : undefined);
	const status = (
		<span role="status" className="sr-only">
			{t`Loading`}
		</span>
	);

	// Edge-to-edge screens and plugin pages (the splat routes) lay out their own header.
	if (match?.staticData?.fullBleed || params._splat !== undefined) return status;

	return (
		<div className="flex min-h-9 items-center">
			{status}
			{title ? (
				<h1 className="text-2xl font-semibold leading-tight">{title}</h1>
			) : (
				<TitlePlaceholder height={30} />
			)}
		</div>
	);
}

/** A settings page's header, as SettingsFrame lays it out, while the page's code loads. */
export function SettingsPagePending() {
	const { t } = useLingui();
	const staticData = usePendingMatch()?.staticData;
	const heading = staticData?.heading ?? staticData?.pageTitle;
	return (
		<div className="max-w-4xl pb-6">
			<span role="status" className="sr-only">
				{t`Loading`}
			</span>
			<EditorHeader
				leading={
					<div className="self-start">
						<BackToSettingsLink />
					</div>
				}
			>
				<div>
					{heading ? (
						<h1 className="text-2xl font-semibold leading-tight text-balance">{t(heading)}</h1>
					) : (
						<TitlePlaceholder height={30} />
					)}
					<div className="mt-1.5 w-72 max-w-full" aria-hidden="true">
						<SkeletonLine blockHeight={20} minWidth={100} maxWidth={100} />
					</div>
				</div>
			</EditorHeader>
		</div>
	);
}

// Fixed, so the outline keeps its shape when the editor's code and then its entry load.
const RAIL_HEADING_WIDTHS = [40, 55, 45];

/** The content editor's bar and settings rail, shown while its code or the entry loads. */
export function EditorFramePending() {
	const { t } = useLingui();
	const params: Params = usePendingMatch()?.params ?? {};
	const collection = params.collection;
	const manifest = useManifest();
	const collectionLabel = collection ? manifest?.collections[collection]?.label : undefined;
	return (
		<div className="flex h-full flex-col bg-kumo-elevated">
			<span role="status" className="sr-only">
				{t`Loading entry`}
			</span>
			<div className="@container/editor-bar flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 border-b border-kumo-line px-3 py-2 sm:flex-nowrap sm:px-4">
				{collection ? (
					<RouterLinkButton
						to="/content/$collection"
						params={{ collection }}
						search={{ locale: undefined }}
						aria-label={t`Back to ${{ collectionLabel: collectionLabel ?? collection }} list`}
						variant="ghost"
						shape="square"
						size="sm"
						icon={<ArrowPrev className="size-4" />}
					/>
				) : (
					<div className="size-6.5 shrink-0" />
				)}
				<div className="flex min-h-7.5 min-w-0 flex-1 items-center gap-1.5" aria-hidden="true">
					{collectionLabel && (
						<>
							<span className="hidden max-w-48 shrink-0 truncate text-base text-kumo-subtle @[44rem]/editor-bar:block">
								{collectionLabel}
							</span>
							<span className="hidden text-kumo-inactive @[44rem]/editor-bar:block">/</span>
						</>
					)}
					<div className="w-40">
						<SkeletonLine blockHeight={24} minWidth={100} maxWidth={100} />
					</div>
				</div>
				<div
					className="grid w-full grid-cols-4 items-center gap-1.5 sm:ms-1.5 sm:flex sm:w-auto sm:justify-end"
					aria-hidden="true"
				>
					<div className="skeleton-line h-6.5 w-full rounded-md sm:w-16" />
					<div className="skeleton-line h-6.5 w-full rounded-md sm:w-20" />
					<div className="skeleton-line h-6.5 w-full rounded-md sm:w-6.5" />
				</div>
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="min-w-0 flex-1">
					<div className="emdash-editor-page mx-auto w-full max-w-[52rem] pt-8 sm:pt-12">
						<EditorFieldsPlaceholder />
					</div>
				</div>
				<div
					className="hidden w-92 shrink-0 border-s border-kumo-line bg-kumo-base lg:block"
					aria-hidden="true"
				>
					{RAIL_HEADING_WIDTHS.map((width) => (
						<div key={width} className="border-t border-kumo-line p-4 first:border-t-0">
							<div className="mb-4">
								<SkeletonLine blockHeight={24} minWidth={width} maxWidth={width} />
							</div>
							<div className="skeleton-line h-9 w-full rounded-lg" />
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

const CONTENT_TYPE_SETTING_WIDTHS = [40, 36, 30];
const CONTENT_TYPE_FIELD_WIDTHS = [28, 36, 22, 32, 40, 26];
// ContentTypeEditor lists this many system fields above the custom ones.
const SYSTEM_FIELD_COUNT = 7;

function FieldRowPlaceholder({ index, system }: { index: number; system?: boolean }) {
	const width = CONTENT_TYPE_FIELD_WIDTHS[index % CONTENT_TYPE_FIELD_WIDTHS.length] ?? 30;
	return (
		<div className={system ? "flex items-center px-4 py-2" : "flex items-center px-4 py-3"}>
			<div className="w-8 shrink-0" />
			<div className="min-w-0 flex-1">
				<SkeletonLine blockHeight={system ? 20 : 24} minWidth={width} maxWidth={width} />
				<div className={system ? "mt-0.5" : "mt-1"}>
					<SkeletonLine blockHeight={16} minWidth={width + 20} maxWidth={width + 20} />
				</div>
			</div>
		</div>
	);
}

/**
 * The content type editor, in outline, while its code or the content type loads. The
 * name and field count come from the manifest, which the admin already has.
 */
export function ContentTypeEditorPending() {
	const { t } = useLingui();
	const params: Params = usePendingMatch()?.params ?? {};
	const slug = params.slug;
	const manifest = useManifest();
	const collection = slug ? manifest?.collections[slug] : undefined;
	const customFieldCount = collection
		? Object.keys(collection.fields).length
		: CONTENT_TYPE_FIELD_WIDTHS.length;
	return (
		<div className="space-y-6">
			<span role="status" className="sr-only">
				{t`Loading`}
			</span>
			<EditorHeader
				leading={
					<RouterLinkButton
						to="/content-types"
						aria-label={t`Back to Content Types`}
						variant="ghost"
						shape="square"
						icon={<ArrowPrev />}
					/>
				}
				actions={slug ? <PendingSaveAction /> : null}
			>
				{!slug ? (
					<h1 className="truncate text-2xl font-semibold">{t`New Content Type`}</h1>
				) : collection ? (
					<h1 className="truncate text-2xl font-semibold">{collection.label}</h1>
				) : (
					<TitlePlaceholder height={32} />
				)}
				{slug && (
					<p className="text-kumo-subtle text-sm">
						<code dir="ltr" className="bg-kumo-tint px-1.5 py-0.5 rounded">
							{slug}
						</code>
					</p>
				)}
			</EditorHeader>
			<div className="grid grid-cols-1 gap-6 lg:grid-cols-3" aria-hidden="true">
				<div className="lg:col-span-1">
					<div className="space-y-4 rounded-lg border bg-kumo-base p-4">
						<h2 className="font-semibold">{t`Settings`}</h2>
						{CONTENT_TYPE_SETTING_WIDTHS.map((width) => (
							<div key={width} className="grid gap-1.5">
								<SkeletonLine blockHeight={20} minWidth={width} maxWidth={width} />
								<div className="skeleton-line h-9 w-full rounded-lg" />
							</div>
						))}
					</div>
				</div>
				{slug && (
					<div className="lg:col-span-2">
						<div className="rounded-lg border bg-kumo-base">
							<div className="flex items-center justify-between border-b p-4">
								<div>
									<h2 className="font-semibold">{t`Fields`}</h2>
									<div className="w-36">
										<SkeletonLine blockHeight={20} minWidth={100} maxWidth={100} />
									</div>
								</div>
								<div className="skeleton-line h-9 w-28 rounded-lg" />
							</div>
							<div className="border-b bg-kumo-tint/50 px-4 py-2 text-xs font-medium tracking-wider text-kumo-subtle uppercase">
								{t`System Fields`}
							</div>
							<div className="divide-y divide-kumo-line/50 border-b">
								{Array.from({ length: SYSTEM_FIELD_COUNT }, (_, index) => (
									<FieldRowPlaceholder key={index} index={index} system />
								))}
							</div>
							{customFieldCount > 0 && (
								<>
									<div className="border-b bg-kumo-tint/50 px-4 py-2 text-xs font-medium tracking-wider text-kumo-subtle uppercase">
										{t`Custom Fields`}
									</div>
									<div className="divide-y">
										{Array.from({ length: customFieldCount }, (_, index) => (
											<FieldRowPlaceholder key={index} index={index} />
										))}
									</div>
								</>
							)}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

/** A sign-in card in outline, as admin.astro renders it, while a standalone screen's code loads. */
export function StandalonePending() {
	const { t } = useLingui();
	return (
		<div className="emdash-standalone">
			<span className="sr-only" role="status">
				{t`Loading`}
			</span>
			<div className="emdash-standalone-column" aria-hidden="true">
				<div className="emdash-standalone-heading">
					<div className="skeleton-line emdash-standalone-logo" />
					<div className="skeleton-line emdash-standalone-title" />
				</div>
				<div className="emdash-standalone-card">
					<div className="skeleton-line emdash-standalone-control" />
					<div className="skeleton-line emdash-standalone-text" />
					<div className="skeleton-line emdash-standalone-text" />
					<div className="skeleton-line emdash-standalone-control" />
				</div>
			</div>
		</div>
	);
}
