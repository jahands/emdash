import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

export function QueryErrorState({ onRetry, error }: { onRetry: () => void; error?: unknown }) {
	const { t } = useLingui();
	return (
		<div role="alert" className="rounded-lg border border-kumo-line bg-kumo-base p-6 text-center">
			<h2 className="text-lg font-semibold">{t`Something went wrong`}</h2>
			<p className="mt-2 text-sm text-kumo-subtle">
				{!navigator.onLine || error instanceof TypeError
					? t`Check your connection and try again.`
					: t`We couldn’t load this information. Try again.`}
			</p>
			<Button className="mx-auto mt-4" onClick={onRetry}>{t`Retry`}</Button>
		</div>
	);
}
