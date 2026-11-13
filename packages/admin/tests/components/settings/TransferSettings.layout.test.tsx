import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../../dist/styles.css";
import type {
	TransferCapabilities,
	TransferOperation,
	TransferPage,
} from "../../../src/lib/api/transfer.js";
import { deferred, watchMovement } from "../../utils/geometry.js";
import { render } from "../../utils/render.js";

const api = vi.hoisted(() => ({
	fetchTransferCapabilities: vi.fn(),
	fetchTransferExports: vi.fn(),
	fetchTransferImports: vi.fn(),
	fetchTransferApprovals: vi.fn(),
}));

vi.mock("../../../src/lib/api/transfer.js", async () => {
	const actual = await vi.importActual<typeof import("../../../src/lib/api/transfer.js")>(
		"../../../src/lib/api/transfer.js",
	);
	return { ...actual, ...api };
});
vi.mock("../../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({
		data: { id: "admin", email: "admin@example.com", role: 50 },
		isLoading: false,
	}),
}));
vi.mock("../../../src/lib/api/users.js", () => ({
	fetchUsers: vi.fn(async () => ({ items: [] })),
}));
vi.mock("../../../src/components/settings/BackToSettingsLink.js", () => ({
	BackToSettingsLink: () => <a href="/settings">Back to Settings</a>,
}));

const { TransferSettings } = await import("../../../src/components/settings/TransferSettings.js");

const capabilities: TransferCapabilities = {
	formatVersions: ["1"],
	features: [],
	optionalFeatures: [],
	limits: {
		manifestBytes: 8_388_608,
		recordLineBytes: 1_900_000,
		chunkBytes: 4_194_304,
		chunkRecords: 1000,
		totalRecords: 5_000_000,
		totalFiles: 1_000_000,
		indexChunks: 1000,
		jsonDepth: 64,
		maxBlobBytes: 52_428_800,
	},
	portableDomain: { empty: false, blockers: [], seededScaffold: [] },
};

const sections = [
	"fetchTransferExports",
	"fetchTransferImports",
	"fetchTransferApprovals",
] as const;

describe("Transfer settings while the transfer history loads", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it.each(sections)(
		"keeps every section heading in place when %s answers last with no history",
		async (lastToAnswer) => {
			const last = deferred<TransferPage<TransferOperation>>();
			api.fetchTransferCapabilities.mockResolvedValue(capabilities);
			for (const name of sections) {
				if (name === lastToAnswer) api[name].mockReturnValue(last.promise);
				else api[name].mockResolvedValue({ items: [] });
			}

			const headings = watchMovement("h1, h2");
			const screen = await render(<TransferSettings />);
			await vi.waitFor(() => {
				for (const name of sections) expect(api[name]).toHaveBeenCalled();
			});
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));

			last.resolve({ items: [] });
			await expect.element(screen.getByText("No pending requests")).toBeVisible();
			await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));

			expect(headings.stop()).toBeLessThanOrEqual(1);
		},
	);
});
