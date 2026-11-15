import { describe, expect, it } from "vitest";

import "../../../dist/styles.css";
import { CalendarToolbar } from "../../../src/components/calendar/CalendarToolbar";
import { createCalendarDisplay } from "../../../src/lib/calendar";
import { render } from "../../utils/render.tsx";

const display = createCalendarDisplay({
	locale: "en",
	timeZone: "UTC",
	viewerTimeZone: "UTC",
	collections: [],
	showLocale: false,
});

function toolbar({ loading, notice }: { loading: boolean; notice?: string }) {
	return (
		<div style={{ width: 900 }}>
			<CalendarToolbar
				title="October 2026"
				display={display}
				zoneTime={Date.parse("2026-10-15T12:00:00.000Z")}
				loading={loading}
				view="month"
				onViewChange={() => {}}
				onPrevious={() => {}}
				onNext={() => {}}
				onToday={() => {}}
				notice={notice && <span>{notice}</span>}
			/>
		</div>
	);
}

describe("CalendarToolbar", () => {
	it("keeps the month buttons in place while the range loads and after", async () => {
		const screen = await render(toolbar({ loading: true }));
		const previous = () =>
			screen.getByRole("button", { name: "Previous month" }).element().getBoundingClientRect().left;

		expect(screen.getByRole("status").element()).toHaveTextContent("Loading...");
		expect(document.querySelector("svg[role='status']")).toBeNull();
		const loadingLeft = previous();

		await screen.rerender(toolbar({ loading: false }));
		expect(screen.getByRole("status").query()).toBeNull();
		expect(previous()).toBe(loadingLeft);

		await screen.rerender(toolbar({ loading: false, notice: "!" }));
		await expect.element(screen.getByText("!")).toBeVisible();
		expect(previous()).toBe(loadingLeft);
	});
});
