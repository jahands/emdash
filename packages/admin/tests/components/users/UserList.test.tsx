import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { UserList } from "../../../src/components/users/UserList.js";
import type { UserListItem } from "../../../src/lib/api/index.js";
import { render } from "../../utils/render.js";

function makeUser(overrides: Partial<UserListItem> = {}): UserListItem {
	return {
		id: "user-1",
		email: "ada@example.com",
		name: "Ada Lovelace",
		avatarUrl: null,
		role: 30,
		emailVerified: true,
		disabled: false,
		createdAt: "2025-01-01T00:00:00Z",
		updatedAt: "2025-01-02T00:00:00Z",
		lastLogin: "2025-01-02T00:00:00Z",
		credentialCount: 1,
		oauthProviders: [],
		...overrides,
	};
}

const noop = () => {};

describe("UserList", () => {
	it("opens a user's details from the name button with the keyboard", async () => {
		const onSelectUser = vi.fn();
		const screen = await render(
			<UserList
				users={[makeUser()]}
				searchQuery=""
				roleFilter={undefined}
				onSearchChange={noop}
				onRoleFilterChange={noop}
				onSelectUser={onSelectUser}
				onInviteUser={noop}
			/>,
		);

		const nameButton = screen.getByRole("button", { name: "Ada Lovelace" }).element();
		for (let i = 0; i < 10 && document.activeElement !== nameButton; i++) {
			await userEvent.tab();
		}
		expect(document.activeElement).toBe(nameButton);

		await userEvent.keyboard("{Enter}");

		expect(onSelectUser).toHaveBeenCalledWith("user-1");
	});

	it("keeps the rows and Load More in place while a new search loads", async () => {
		const props = {
			users: [makeUser()],
			hasMore: true,
			searchQuery: "",
			roleFilter: undefined,
			onSearchChange: noop,
			onRoleFilterChange: noop,
			onSelectUser: noop,
			onInviteUser: noop,
		};
		const screen = await render(<UserList {...props} />);
		const rows = () => screen.getByRole("table").element().querySelectorAll("tbody tr");
		await expect.element(screen.getByRole("button", { name: "Load More" })).toBeVisible();

		await screen.rerender(<UserList {...props} searchQuery="ada" isRefreshing />);

		await expect.element(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
		expect(rows()).toHaveLength(1);
		expect(screen.getByRole("status").query()).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Load More" })).toBeEnabled();
	});

	it("says in the table when the users can't be loaded, and loads them again on request", async () => {
		const onRetry = vi.fn();
		const screen = await render(
			<UserList
				users={[]}
				loadError="Failed to load users: Server unavailable"
				onRetry={onRetry}
				searchQuery=""
				roleFilter={undefined}
				onSearchChange={noop}
				onRoleFilterChange={noop}
				onSelectUser={noop}
				onInviteUser={noop}
			/>,
		);

		const alert = screen.getByRole("table").getByRole("alert");
		await expect.element(alert).toHaveTextContent("Failed to load users: Server unavailable");
		await expect.element(screen.getByRole("heading", { name: "Users" })).toBeVisible();
		await alert.getByRole("button", { name: "Try again" }).click();
		expect(onRetry).toHaveBeenCalled();
	});
});
