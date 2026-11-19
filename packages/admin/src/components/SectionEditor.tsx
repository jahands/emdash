/**
 * Section editor page component
 *
 * Edit a section's content and metadata.
 */

import { Input, InputArea, Label, SkeletonLine, useKumoToastManager } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchManifest,
	fetchSection,
	updateSection,
	type Section,
	type SectionsResult,
	type UpdateSectionInput,
} from "../lib/api";
import { getPluginBlocks } from "../lib/pluginBlocks";
import { useLiveQueries } from "../lib/realtime/LiveSyncProvider.js";
import { cn, slugify } from "../lib/utils";
import { ArrowPrev } from "./ArrowIcons.js";
import { ChangedElsewhereNotice } from "./ChangedElsewhereNotice.js";
import { GalleryDetailPanel } from "./editor/GalleryDetailPanel";
import type { GalleryAttributes } from "./editor/GalleryNode";
import { ImageDetailPanel, type ImageAttributes } from "./editor/ImageDetailPanel";
import { EditorFieldsPlaceholder } from "./EditorFieldsPlaceholder.js";
import { EditorHeader } from "./EditorHeader";
import {
	PortableTextEditor,
	type BlockSidebarPanel,
	type PluginBlockDef,
} from "./PortableTextEditor";
import { ScreenPresence } from "./presence/ScreenPresence.js";
import { RouterLinkButton } from "./RouterLinkButton.js";
import { SaveButton } from "./SaveButton";
import { PendingSaveAction } from "./settings/SettingsLayout.js";

const SECTION_DETAIL_FIELDS: Array<{
	label: MessageDescriptor;
	help?: MessageDescriptor;
	multiline?: boolean;
}> = [
	{ label: msg`Title` },
	{
		label: msg`Slug`,
		help: msg`Used to identify this section. Lowercase letters, numbers, and hyphens only.`,
	},
	{ label: msg`Description`, multiline: true },
	{ label: msg`Keywords`, help: msg`Comma-separated keywords for search.` },
];

export function SectionEditor() {
	const { t } = useLingui();
	const { slug } = useParams({ from: "/_admin/sections/$slug" });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();

	const {
		data: section,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["sections", slug],
		queryFn: () => fetchSection(slug),
		staleTime: Infinity,
		// List rows are whole sections, so one opened from the list draws at once.
		placeholderData: () =>
			queryClient
				.getQueriesData<SectionsResult | Section>({ queryKey: ["sections"] })
				.flatMap(([, data]) => (data && "items" in data ? data.items : []))
				.find((listed) => listed.slug === slug),
	});

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const pluginBlocks = React.useMemo(() => (manifest ? getPluginBlocks(manifest) : []), [manifest]);

	const updateMutation = useMutation({
		mutationFn: (input: UpdateSectionInput) => updateSection(slug, input),
		onSuccess: (updated) => {
			void queryClient.invalidateQueries({ queryKey: ["sections"] });
			void queryClient.invalidateQueries({ queryKey: ["sections", slug] });
			// If slug changed, navigate to new URL
			if (updated.slug !== slug) {
				void navigate({ to: "/sections/$slug", params: { slug: updated.slug } });
			}
		},
		onError: (mutationError: Error) => {
			toastManager.add({
				title: t`Error saving section`,
				description: mutationError.message,
				variant: "error",
			});
		},
	});

	if (isLoading) {
		return (
			<div className="space-y-6">
				<span role="status" className="sr-only">
					{t`Loading section...`}
				</span>
				<EditorHeader
					leading={
						<RouterLinkButton
							to="/sections"
							aria-label={t`Back to sections`}
							variant="ghost"
							shape="square"
							icon={<ArrowPrev />}
						/>
					}
					actions={<PendingSaveAction />}
				>
					<div className="w-56" aria-hidden="true">
						<div className="text-2xl font-semibold">
							<SkeletonLine blockHeight="1lh" minWidth={100} maxWidth={100} />
						</div>
						<div className="text-sm">
							<SkeletonLine blockHeight="1lh" minWidth={60} maxWidth={60} />
						</div>
					</div>
				</EditorHeader>
				<div className="grid gap-6 xl:grid-cols-12">
					<div className="min-w-0 rounded-lg border bg-kumo-base p-6 xl:col-span-8">
						<Label className="mb-4 block text-lg font-semibold">{t`Content`}</Label>
						<EditorFieldsPlaceholder />
					</div>
					<div className="min-w-0 space-y-4 rounded-lg border bg-kumo-base p-6 xl:col-span-4">
						<h2 className="text-lg font-semibold">{t`Section Details`}</h2>
						{SECTION_DETAIL_FIELDS.map((field) => (
							<div key={field.label.id}>
								<div className="grid gap-2">
									<span className="text-base font-medium">{t(field.label)}</span>
									<div
										aria-hidden="true"
										className={cn(
											"skeleton-line w-full rounded-lg",
											field.multiline ? "h-20" : "h-9",
										)}
									/>
								</div>
								{field.help && <p className="mt-1 text-xs text-kumo-subtle">{t(field.help)}</p>}
							</div>
						))}
					</div>
				</div>
			</div>
		);
	}

	if (error || !section) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<RouterLinkButton
						to="/sections"
						aria-label={t`Back to sections`}
						variant="ghost"
						shape="square"
						icon={<ArrowPrev />}
					/>
					<h1 className="text-2xl font-semibold leading-tight">{t`Section Not Found`}</h1>
				</div>
				<div className="rounded-lg border bg-kumo-base p-6">
					<p className="text-kumo-subtle">
						{error ? error.message : t`Section "${slug}" could not be found.`}
					</p>
				</div>
			</div>
		);
	}

	return (
		<SectionEditorForm
			key={section.updatedAt}
			section={section}
			isSaving={updateMutation.isPending}
			pluginBlocks={pluginBlocks}
			onSave={(input) => updateMutation.mutate(input)}
		/>
	);
}

interface SectionEditorFormProps {
	section: Section;
	isSaving: boolean;
	pluginBlocks: PluginBlockDef[];
	onSave: (input: UpdateSectionInput) => void;
}

function SectionEditorForm({ section, isSaving, pluginBlocks, onSave }: SectionEditorFormProps) {
	const { t } = useLingui();
	const [title, setTitle] = React.useState(section.title);
	const [sectionSlug, setSectionSlug] = React.useState(section.slug);
	const [slugTouched, setSlugTouched] = React.useState(true); // Existing sections have touched slugs
	const [description, setDescription] = React.useState(section.description || "");
	const [keywords, setKeywords] = React.useState(section.keywords.join(", "));
	const [content, setContent] = React.useState<unknown[]>(section.content);

	// Track initial state for dirty checking
	const [lastSavedData] = React.useState(() =>
		JSON.stringify({
			title: section.title,
			slug: section.slug,
			description: section.description || "",
			keywords: section.keywords.join(", "),
			content: section.content,
		}),
	);

	// Auto-generate slug from title if editing title and slug hasn't been manually changed
	React.useEffect(() => {
		if (!slugTouched && title && title !== section.title) {
			setSectionSlug(slugify(title));
		}
	}, [title, slugTouched, section.title]);

	const currentData = React.useMemo(
		() => JSON.stringify({ title, slug: sectionSlug, description, keywords, content }),
		[title, sectionSlug, description, keywords, content],
	);
	const isDirty = currentData !== lastSavedData;
	// A refetch gives the section a new `updatedAt`, which remounts this form with it.
	const live = useLiveQueries({ queryKeys: [["sections", section.slug]], dirty: isDirty });

	// Block sidebar state populated when a node view (e.g. ImageNode) requests
	// sidebar space.
	const [blockSidebarPanel, setBlockSidebarPanel] = React.useState<BlockSidebarPanel | null>(null);

	const handleBlockSidebarOpen = React.useCallback((panel: BlockSidebarPanel) => {
		setBlockSidebarPanel(panel);
	}, []);

	const handleBlockSidebarClose = React.useCallback(() => {
		setBlockSidebarPanel((prev) => {
			prev?.onClose();
			return null;
		});
	}, []);

	const handleSave = () => {
		const keywordsArray = keywords
			.split(",")
			.map((k) => k.trim())
			.filter(Boolean);

		onSave({
			title,
			slug: sectionSlug,
			description: description || undefined,
			keywords: keywordsArray,
			content,
		});
	};

	return (
		<div className="space-y-6">
			<EditorHeader
				leading={
					<RouterLinkButton
						to="/sections"
						aria-label={t`Back to sections`}
						variant="ghost"
						shape="square"
						icon={<ArrowPrev />}
					/>
				}
				actions={
					<>
						<ScreenPresence topic={`sections/${section.slug}`} editing={isDirty} />
						<SaveButton isSaving={isSaving} isDirty={isDirty} onClick={handleSave} />
					</>
				}
			>
				<h1 className="truncate text-2xl font-semibold">{section.title}</h1>
				<p className="text-sm text-kumo-subtle">
					{section.source === "theme" ? t`Theme Section` : t`Custom Section`} &middot;{" "}
					<bdi dir="ltr">{section.slug}</bdi>
				</p>
			</EditorHeader>

			{live.changedElsewhere && <ChangedElsewhereNotice onLoad={live.loadLatest} />}

			<div className="grid gap-6 xl:grid-cols-12">
				{/* Main content */}
				<div className="min-w-0 space-y-6 xl:col-span-8">
					{/* Content editor */}
					<div className="rounded-lg border bg-kumo-base p-6">
						<Label className="text-lg font-semibold mb-4 block">{t`Content`}</Label>
						<PortableTextEditor
							value={content as Parameters<typeof PortableTextEditor>[0]["value"]}
							onChange={(value) => setContent(value)}
							pluginBlocks={pluginBlocks}
							onBlockSidebarOpen={handleBlockSidebarOpen}
							onBlockSidebarClose={handleBlockSidebarClose}
						/>
					</div>

					{/* Save action at the bottom of the main column so users hit
					    it naturally when they finish editing, without needing to
					    scroll past the entire sidebar. */}
					<div className="flex items-center justify-end gap-2">
						<SaveButton
							isSaving={isSaving}
							isDirty={isDirty}
							announce={false}
							onClick={handleSave}
						/>
					</div>
				</div>

				{/* Sidebar */}
				<div className="min-w-0 space-y-6 xl:col-span-4">
					{blockSidebarPanel?.type === "image" ? (
						<ImageDetailPanel
							attributes={blockSidebarPanel.attrs as unknown as ImageAttributes}
							onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
							onReplace={(attrs) =>
								blockSidebarPanel.onReplace(attrs as unknown as Record<string, unknown>)
							}
							onDelete={() => {
								blockSidebarPanel.onDelete();
								setBlockSidebarPanel(null);
							}}
							onClose={handleBlockSidebarClose}
							inline
						/>
					) : blockSidebarPanel?.type === "gallery" ? (
						<GalleryDetailPanel
							attributes={blockSidebarPanel.attrs as unknown as GalleryAttributes}
							onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
							onDelete={() => {
								blockSidebarPanel.onDelete();
								setBlockSidebarPanel(null);
							}}
							onClose={handleBlockSidebarClose}
							inline
						/>
					) : (
						<>
							{/* Metadata */}
							<div className="rounded-lg border bg-kumo-base p-6 space-y-4">
								<h2 className="text-lg font-semibold">{t`Section Details`}</h2>

								<Input
									label={t`Title`}
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									placeholder={t`Section title`}
								/>

								<div>
									<Input
										dir="ltr"
										label={t`Slug`}
										value={sectionSlug}
										onChange={(e) => {
											setSectionSlug(e.target.value);
											setSlugTouched(true);
										}}
										placeholder="section-slug"
										pattern="[a-z0-9\-]+"
									/>
									<p className="text-xs text-kumo-subtle mt-1">
										{t`Used to identify this section. Lowercase letters, numbers, and hyphens only.`}
									</p>
								</div>

								<InputArea
									label={t`Description`}
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									placeholder={t`Describe what this section is for...`}
									rows={3}
								/>

								<div>
									<Input
										label={t`Keywords`}
										value={keywords}
										onChange={(e) => setKeywords(e.target.value)}
										placeholder={t`hero, banner, cta`}
									/>
									<p className="text-xs text-kumo-subtle mt-1">{t`Comma-separated keywords for search.`}</p>
								</div>
							</div>

							{/* Source info */}
							<div className="rounded-lg border bg-kumo-base p-6">
								<h2 className="text-lg font-semibold mb-2">{t`Source`}</h2>
								<p className="text-sm text-kumo-subtle">
									{section.source === "theme" && (
										<>
											{t`This section is provided by the theme. Editing will create a custom copy that overrides the theme version.`}
										</>
									)}
									{section.source === "user" && <>{t`This is a custom section.`}</>}
									{section.source === "import" && (
										<>{t`This section was imported from another system.`}</>
									)}
								</p>
								{section.themeId && (
									<p className="text-xs text-kumo-subtle mt-2">{t`Theme ID: ${section.themeId}`}</p>
								)}
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
