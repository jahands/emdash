import { Banner, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

/** Shown over a form with unsaved edits when what it edits changed somewhere else. */
export function ChangedElsewhereNotice({ onLoad }: { onLoad(): Promise<void> }) {
	const { t } = useLingui();
	const [loading, setLoading] = React.useState(false);
	return (
		<Banner
			variant="alert"
			role="status"
			title={t`This changed somewhere else`}
			description={t`Your unsaved edits are still here. Loading the new version replaces them.`}
			action={
				<Button
					size="sm"
					variant="secondary"
					type="button"
					loading={loading}
					onClick={() => {
						setLoading(true);
						void onLoad().finally(() => setLoading(false));
					}}
				>
					{t`Load new version`}
				</Button>
			}
		/>
	);
}
