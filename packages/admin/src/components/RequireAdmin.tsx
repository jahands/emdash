import { Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useCurrentUser } from "../lib/api/current-user.js";
import { QueryErrorState } from "./QueryErrorState.js";

const ROLE_ADMIN = 50;

export function RequireAdmin({
	children,
	minimumRole = ROLE_ADMIN,
}: {
	children: React.ReactNode;
	minimumRole?: number;
}) {
	const { t } = useLingui();
	const { data: currentUser, isPending, isError, isFetching, refetch } = useCurrentUser();

	if (!currentUser && (isPending || isFetching)) {
		return (
			<div className="flex items-center justify-center min-h-[50vh]">
				<Loader />
			</div>
		);
	}

	if (!currentUser && isError) {
		return <QueryErrorState onRetry={() => void refetch()} />;
	}

	if (!currentUser || currentUser.role < minimumRole) {
		return (
			<div className="flex items-center justify-center min-h-[50vh]">
				<div className="text-center">
					<h1 className="text-2xl font-semibold leading-tight">{t`Access denied`}</h1>
					<p className="mt-2 text-sm text-kumo-subtle">
						{minimumRole === ROLE_ADMIN
							? t`You need admin permissions to view this page.`
							: t`You do not have permission to view this page.`}
					</p>
				</div>
			</div>
		);
	}

	return <>{children}</>;
}
