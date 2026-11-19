import { Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { UserPlus, Prohibit, CheckCircle } from "@phosphor-icons/react";
import * as React from "react";

import type { UserListItem } from "../../lib/api";
import { cn, formatDate } from "../../lib/utils.js";
import { Button } from "../Button.js";
import {
	DataTable,
	DataTableLoadError,
	DataTableMessage,
	DataTablePlaceholderRows,
	RowMeta,
	RowTitleButton,
	secondaryColumn,
	tertiaryColumn,
} from "../DataTable.js";
import { TableToolbar, TableToolbarSearch } from "../TableToolbar.js";
import { UserAvatar } from "../UserAvatar.js";
import { RoleBadge } from "./RoleBadge";
import { useRolesConfig } from "./useRolesConfig.js";

export interface UserListProps {
	users: UserListItem[];
	/** The first page is loading, so there are no rows yet. */
	isLoading?: boolean;
	/** Rows for a new search or filter are loading while the last ones stay. */
	isRefreshing?: boolean;
	isLoadingMore?: boolean;
	/** The first page failed to load. */
	loadError?: string;
	onRetry?: () => void;
	hasMore?: boolean;
	searchQuery: string;
	roleFilter: number | undefined;
	onSearchChange: (query: string) => void;
	onRoleFilterChange: (role: number | undefined) => void;
	onSelectUser: (id: string) => void;
	onInviteUser: () => void;
	onLoadMore?: () => void;
}

/**
 * User list component with search, filter, and table display
 */
export function UserList({
	users,
	isLoading,
	isRefreshing,
	isLoadingMore,
	loadError,
	onRetry,
	hasMore,
	searchQuery,
	roleFilter,
	onSearchChange,
	onRoleFilterChange,
	onSelectUser,
	onInviteUser,
	onLoadMore,
}: UserListProps) {
	const { t } = useLingui();
	const { roles, roleLabels } = useRolesConfig();
	const roleFilterSelectItems = React.useMemo(
		() => ({ all: t`All roles`, ...roleLabels }),
		[t, roleLabels],
	);
	const roleFilterSelectOptions = React.useMemo(
		() => [{ value: "all", label: t`All roles` }, ...roles],
		[t, roles],
	);

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<h1 className="min-w-0 text-2xl font-semibold leading-tight">{t`Users`}</h1>
				<Button onClick={onInviteUser} icon={<UserPlus />}>
					{t`Invite User`}
				</Button>
			</div>

			<TableToolbar>
				<TableToolbarSearch
					placeholder={t`Search by name or email...`}
					value={searchQuery}
					onChange={(e) => onSearchChange(e.target.value)}
					aria-label={t`Search users`}
				/>
				<Select
					size="sm"
					value={roleFilter?.toString() ?? "all"}
					onValueChange={(value) =>
						onRoleFilterChange(value === "all" || value === null ? undefined : parseInt(value, 10))
					}
					items={roleFilterSelectItems}
					aria-label={t`Filter by role`}
				>
					{roleFilterSelectOptions.map((option) => (
						<Select.Option key={option.value} value={option.value}>
							{option.label}
						</Select.Option>
					))}
				</Select>
			</TableToolbar>

			<DataTable aria-busy={isRefreshing || undefined}>
				<thead>
					<tr>
						<th scope="col">{t`User`}</th>
						{/* Fixed widths keep the columns where they are when rows replace the placeholder rows. */}
						<th scope="col" className="w-36" {...secondaryColumn}>
							{t`Role`}
						</th>
						<th scope="col" className="w-32" {...secondaryColumn}>
							{t`Status`}
						</th>
						<th scope="col" className="w-36" {...tertiaryColumn}>
							{t`Last Login`}
						</th>
						<th scope="col" className="w-28" {...tertiaryColumn}>
							{t`Passkeys`}
						</th>
					</tr>
				</thead>
				<tbody>
					{loadError !== undefined ? (
						<DataTableLoadError colSpan={5} onRetry={() => onRetry?.()}>
							{loadError}
						</DataTableLoadError>
					) : users.length === 0 && isLoading ? (
						<DataTablePlaceholderRows
							cells={["title", "secondary", "secondary", "tertiary", "tertiary"]}
						/>
					) : users.length === 0 ? (
						<DataTableMessage colSpan={5}>
							{searchQuery || roleFilter !== undefined ? (
								<>
									{t`No users found matching your filters.`}{" "}
									<button
										type="button"
										className="text-kumo-link underline"
										onClick={() => {
											onSearchChange("");
											onRoleFilterChange(undefined);
										}}
									>
										{t`Clear filters`}
									</button>
								</>
							) : (
								<>
									{t`No users yet.`}{" "}
									<button type="button" className="text-kumo-link underline" onClick={onInviteUser}>
										{t`Invite your first team member`}
									</button>
								</>
							)}
						</DataTableMessage>
					) : (
						users.map((user) => (
							<UserListRow key={user.id} user={user} onSelect={() => onSelectUser(user.id)} />
						))
					)}
				</tbody>
			</DataTable>

			{/* Load more */}
			{hasMore && (
				<div className="flex justify-center">
					<Button
						variant="outline"
						onClick={onLoadMore}
						loading={isLoadingMore}
						disabled={isLoadingMore}
					>
						{t`Load More`}
					</Button>
				</div>
			)}
		</div>
	);
}

interface UserListRowProps {
	user: UserListItem;
	onSelect: () => void;
}

function UserListRow({ user, onSelect }: UserListRowProps) {
	const displayName = user.name || user.email;
	const { t, i18n } = useLingui();
	const lastLogin = user.lastLogin ? formatDate(user.lastLogin, i18n.locale) : t`Never`;
	const roleBadge = <RoleBadge role={user.role} />;
	const disabledStatus = (
		<span className="inline-flex items-center gap-1 text-kumo-danger">
			<Prohibit className="h-3.5 w-3.5" aria-hidden="true" />
			{t`Disabled`}
		</span>
	);

	return (
		<tr>
			<td>
				<div className="flex items-center gap-3">
					<UserAvatar user={user} size={32} />
					<div className="wrap-anywhere">
						<RowTitleButton dir="auto" onClick={onSelect}>
							{displayName}
						</RowTitleButton>
						{user.name && (
							<div className="text-sm text-kumo-subtle">
								<bdi dir="ltr">{user.email}</bdi>
							</div>
						)}
						<RowMeta>
							{roleBadge}
							{user.disabled && disabledStatus}
						</RowMeta>
					</div>
				</div>
			</td>
			<td {...secondaryColumn}>{roleBadge}</td>
			<td {...secondaryColumn}>
				{user.disabled ? (
					disabledStatus
				) : (
					<span className="inline-flex items-center gap-1 text-kumo-success">
						<CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
						{t`Active`}
					</span>
				)}
			</td>
			<td className="whitespace-nowrap text-kumo-subtle" {...tertiaryColumn}>
				<bdi>{lastLogin}</bdi>
			</td>
			<td {...tertiaryColumn}>
				<span className={cn(user.credentialCount === 0 && "text-kumo-subtle")}>
					{user.credentialCount}
				</span>
			</td>
		</tr>
	);
}
