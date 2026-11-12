import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AdminBootError } from "../../src/components/AdminBootError";

const LABELS = { title: "فشل تحميل لوحة الإدارة", retry: "حاول مجددًا" };

function BootErrorWithRetry({ onRetry }: { onRetry: () => void }) {
	const [retrying, setRetrying] = React.useState(false);
	return (
		<AdminBootError
			labels={LABELS}
			retrying={retrying}
			onRetry={() => {
				setRetrying(true);
				onRetry();
			}}
		/>
	);
}

describe("AdminBootError", () => {
	afterEach(() => {
		document.getElementById("emdash-boot-loader")?.remove();
	});

	it("replaces the boot spinner with the error and a Retry button", async () => {
		const loader = document.createElement("div");
		loader.id = "emdash-boot-loader";
		document.body.append(loader);
		const onRetry = vi.fn();

		const screen = await render(<BootErrorWithRetry onRetry={onRetry} />);

		await expect.element(screen.getByRole("alert")).toHaveTextContent(LABELS.title);
		expect(document.getElementById("emdash-boot-loader")).toBeNull();

		const retry = screen.getByRole("button", { name: LABELS.retry });
		await retry.click();
		expect(onRetry).toHaveBeenCalledTimes(1);
		await expect.element(retry).toBeDisabled();
	});
});
