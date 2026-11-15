/**
 * Marketplace Browse
 *
 * Grid of plugin cards with search and sorting.
 * Navigates to plugin detail on card click.
 */

import { Badge, Button, Input, Select, SkeletonLine } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	MagnifyingGlass,
	DownloadSimple,
	ShieldCheck,
	ShieldWarning,
	Warning,
	ArrowsClockwise,
} from "@phosphor-icons/react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	CAPABILITY_LABELS,
	searchMarketplace,
	type MarketplacePluginSummary,
	type MarketplaceSearchOpts,
} from "../lib/api/marketplace.js";
import { safeIconUrl } from "../lib/url.js";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";

type SortOption = "installs" | "updated" | "created" | "name";

const SORT_OPTIONS = new Set<string>(["installs", "updated", "created", "name"]);

function isSortOption(value: string): value is SortOption {
	return SORT_OPTIONS.has(value);
}

const SORT_LABELS: Record<SortOption, MessageDescriptor> = {
	installs: msg`Most Popular`,
	updated: msg`Recently Updated`,
	created: msg`Newest`,
	name: msg`Name`,
};

// Fixed, so placeholders shown again after a remount don't change shape.
const CARD_PLACEHOLDER_WIDTHS = [45, 60, 38, 52, 66, 42];

export interface MarketplaceBrowseProps {
	/** IDs of plugins already installed on this site */
	installedPluginIds?: Set<string>;
}

export function MarketplaceBrowse({ installedPluginIds = new Set() }: MarketplaceBrowseProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [sort, setSort] = React.useState<SortOption>("installs");
	const [capability, setCapability] = React.useState<string>("");
	const [debouncedQuery, setDebouncedQuery] = React.useState("");

	// Debounce search input
	React.useEffect(() => {
		const timer = setTimeout(setDebouncedQuery, 300, searchQuery);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	const searchOpts: MarketplaceSearchOpts = {
		q: debouncedQuery || undefined,
		capability: capability || undefined,
		sort,
		limit: 20,
	};

	const {
		data,
		isLoading,
		isPlaceholderData,
		error,
		refetch,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: ["marketplace", "search", searchOpts],
		queryFn: ({ pageParam }) => searchMarketplace({ ...searchOpts, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		placeholderData: keepPreviousData,
	});

	const plugins = data?.pages.flatMap((p) => p.items);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-2xl font-semibold leading-tight">{t`Marketplace`}</h1>
				<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
					{t`Browse and install plugins to extend your site.`}
				</p>
			</div>

			{/* Search + Sort */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="relative flex-1">
					<MagnifyingGlass className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kumo-subtle" />
					<Input
						type="search"
						placeholder={t`Search plugins...`}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="ps-9"
						aria-label={t`Search plugins`}
					/>
				</div>
				<Select
					value={capability}
					onValueChange={(v) => setCapability(v ?? "")}
					items={{
						"": t`All capabilities`,
						...Object.fromEntries(
							Object.entries(CAPABILITY_LABELS).map(([value, label]) => [value, t(label)]),
						),
					}}
					aria-label={t`Filter by capability`}
				/>
				<Select
					value={sort}
					onValueChange={(v) => {
						if (v && isSortOption(v)) setSort(v);
					}}
					items={Object.fromEntries(
						Object.entries(SORT_LABELS).map(([value, label]) => [value, t(label)]),
					)}
					aria-label={t`Sort plugins`}
				/>
			</div>

			{/* Error state */}
			{error && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-6 text-center">
					<Warning className="mx-auto h-8 w-8 text-kumo-danger" />
					<h3 className="mt-3 font-medium text-kumo-danger">{t`Unable to reach marketplace`}</h3>
					<p className="mt-1 text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : t`An error occurred`}
					</p>
					<Button
						variant="ghost"
						className="mt-4"
						onClick={() => void refetch()}
						icon={<ArrowsClockwise />}
					>
						{t`Retry`}
					</Button>
				</div>
			)}

			{isLoading && (
				<>
					<span role="status" className="sr-only">
						{t`Loading plugins...`}
					</span>
					<div aria-hidden="true" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{CARD_PLACEHOLDER_WIDTHS.map((width, index) => (
							<div key={index} className="rounded-lg border bg-kumo-base p-4">
								<div className="flex items-start gap-3">
									<div className="skeleton-line size-10 shrink-0 rounded-lg" />
									<div className="min-w-0 flex-1">
										<SkeletonLine blockHeight="1lh" minWidth={width} maxWidth={width} />
										<SkeletonLine blockHeight={16} minWidth={35} maxWidth={35} />
									</div>
								</div>
								<div className="mt-2 text-sm">
									<SkeletonLine blockHeight="1lh" minWidth={95} maxWidth={95} />
									<SkeletonLine blockHeight="1lh" minWidth={65} maxWidth={65} />
								</div>
								<div className="mt-3">
									<SkeletonLine blockHeight={20} minWidth={20} maxWidth={20} />
								</div>
							</div>
						))}
					</div>
				</>
			)}

			{/* Results grid */}
			{plugins && !isLoading && (
				<>
					{plugins.length === 0 ? (
						<div className="rounded-lg border bg-kumo-base p-8 text-center">
							<ADMIN_NAV_ICONS.plugins className="mx-auto h-12 w-12 text-kumo-subtle" />
							<h3 className="mt-4 text-lg font-medium">{t`No plugins found`}</h3>
							<p className="mt-2 text-sm text-kumo-subtle">
								{debouncedQuery
									? t`No results for "${debouncedQuery}". Try a different search term.`
									: t`The marketplace is empty. Check back later for new plugins.`}
							</p>
						</div>
					) : (
						<>
							<div
								aria-busy={isPlaceholderData || undefined}
								className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
							>
								{plugins.map((plugin) => (
									<PluginCard
										key={plugin.id}
										plugin={plugin}
										isInstalled={installedPluginIds.has(plugin.id)}
									/>
								))}
							</div>
							{hasNextPage && (
								<div className="flex justify-center">
									<Button
										variant="outline"
										onClick={() => void fetchNextPage()}
										disabled={isFetchingNextPage}
									>
										{isFetchingNextPage ? t`Loading...` : t`Load more`}
									</Button>
								</div>
							)}
						</>
					)}
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// PluginCard
// ---------------------------------------------------------------------------

interface PluginCardProps {
	plugin: MarketplacePluginSummary;
	isInstalled: boolean;
}

function PluginCard({ plugin, isInstalled }: PluginCardProps) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const auditVerdict = plugin.latestVersion?.audit?.verdict;
	const imageVerdict = plugin.latestVersion?.imageAudit?.verdict;
	const isImageFlagged = imageVerdict === "warn" || imageVerdict === "fail";
	const iconSrc = plugin.iconUrl ? safeIconUrl(plugin.iconUrl, 64) : null;

	return (
		<Link
			to="/plugins/marketplace/$pluginId"
			params={{ pluginId: plugin.id }}
			className="group block rounded-lg border bg-kumo-base p-4 transition-colors hover:border-kumo-brand/50 hover:bg-kumo-tint/30"
		>
			<div className="flex items-start gap-3">
				{/* Icon */}
				{iconSrc ? (
					<img
						src={iconSrc}
						alt=""
						className={`h-10 w-10 rounded-lg object-cover ${isImageFlagged ? "blur-sm" : ""}`}
						loading="lazy"
						aria-label={isImageFlagged ? t`Icon blurred due to image audit` : undefined}
					/>
				) : (
					<PluginAvatar name={plugin.name} />
				)}

				{/* Name + meta */}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="truncate font-semibold group-hover:text-kumo-link">{plugin.name}</h3>
						{isInstalled && (
							<span
								role="link"
								className="cursor-pointer"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									void navigate({ to: "/plugins-manager" });
								}}
							>
								<Badge variant="secondary">{t`Installed`}</Badge>
							</span>
						)}
					</div>
					<div className="flex items-center gap-2 text-xs text-kumo-subtle">
						<span>{plugin.author.name}</span>
						{plugin.author.verified && <ShieldCheck className="h-3 w-3 text-kumo-link" />}
						{plugin.latestVersion?.version && <span>v{plugin.latestVersion.version}</span>}
					</div>
				</div>
			</div>

			{/* Description */}
			{plugin.description && (
				<p className="mt-2 line-clamp-2 text-sm text-kumo-subtle">{plugin.description}</p>
			)}

			{/* Footer: install count + audit + capabilities */}
			<div className="mt-3 flex items-center justify-between">
				<div className="flex items-center gap-2 text-xs text-kumo-subtle">
					<DownloadSimple className="h-3.5 w-3.5" />
					<span>{formatInstallCount(plugin.installCount)}</span>
				</div>
				<div className="flex items-center gap-1">
					{auditVerdict && <AuditBadge verdict={auditVerdict} />}
					{plugin.capabilities.length > 0 && (
						<span className="text-xs text-kumo-subtle">
							{plural(plugin.capabilities.length, {
								one: "# permission",
								other: "# permissions",
							})}
						</span>
					)}
				</div>
			</div>
		</Link>
	);
}

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function PluginAvatar({ name }: { name: string }) {
	const initial = name.charAt(0).toUpperCase();
	return (
		<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-link font-bold text-lg">
			{initial}
		</div>
	);
}

export function AuditBadge({ verdict }: { verdict: "pass" | "warn" | "fail" }) {
	const { t } = useLingui();
	if (verdict === "pass") {
		return (
			<span
				className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-kumo-success/10 text-kumo-success"
				title={t`Security audit passed`}
			>
				<ShieldCheck className="h-3 w-3" />
				{t`Pass`}
			</span>
		);
	}
	if (verdict === "warn") {
		return (
			<span
				className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-kumo-warning/10 text-kumo-warning"
				title={t`Security audit flagged concerns`}
			>
				<Warning className="h-3 w-3" />
				{t`Warn`}
			</span>
		);
	}
	return (
		<span
			className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-kumo-danger/10 text-kumo-danger"
			title={t`Security audit failed`}
		>
			<ShieldWarning className="h-3 w-3" />
			{t`Fail`}
		</span>
	);
}

function formatInstallCount(count: number): string {
	if (count >= 1000) {
		return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
	}
	return String(count);
}

export default MarketplaceBrowse;
