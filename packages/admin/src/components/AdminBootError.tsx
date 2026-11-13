import { Button } from "@cloudflare/kumo";
import * as React from "react";

import type { AdminBootErrorLabels } from "../locales/server.js";

export interface AdminBootErrorProps {
	/** Resolved on the server: the admin's own catalog may be what failed to load. */
	labels: AdminBootErrorLabels;
	retrying: boolean;
	onRetry: () => void;
}

/** Shown in place of the admin when its code or translations fail to load. */
export function AdminBootError({ labels, retrying, onRetry }: AdminBootErrorProps) {
	React.useEffect(() => {
		document.getElementById("emdash-boot-loader")?.remove();
	}, []);

	return (
		<div className="flex items-center justify-center min-h-screen p-4">
			<div className="flex flex-col items-center text-center" role="alert">
				<h1 className="text-2xl font-semibold leading-tight">{labels.title}</h1>
				<Button onClick={onRetry} loading={retrying} className="mt-4">
					{labels.retry}
				</Button>
			</div>
		</div>
	);
}
