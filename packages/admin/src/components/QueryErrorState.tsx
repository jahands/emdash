import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

export function QueryErrorState({ onRetry }: { onRetry: () => void }) {
	const { t } = useLingui();
	return (
		<div role="alert" className="rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
			<h2 className="text-lg font-semibold">{t`Something went wrong`}</h2>
			<p className="mt-2 text-sm text-kumo-subtle">{t`Check your connection and try again.`}</p>
			<Button className="mt-4" onClick={onRetry}>{t`Retry`}</Button>
		</div>
	);
}
