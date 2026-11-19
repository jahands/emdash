import { useLingui } from "@lingui/react/macro";
import * as React from "react";

const NAV_ITEMS = Array.from({ length: 8 }, (_, index) => index);

/**
 * The admin's frame as admin.astro renders it before the admin loads, shown
 * until the admin's data is ready. With `children`, the frame has stopped
 * loading and shows them in its page area instead, such as an error.
 */
export function AdminFrameSkeleton({ children }: { children?: React.ReactNode }) {
	const { t } = useLingui();
	const settled = children !== undefined;
	return (
		<div className="emdash-frame" data-settled={settled || undefined}>
			{!settled && (
				<span className="sr-only" role="status">
					{t`Loading`}
				</span>
			)}
			<div className="emdash-frame-sidebar" aria-hidden="true">
				<div className="emdash-frame-sidebar-header">
					<div className="skeleton-line emdash-frame-icon" />
					<div className="skeleton-line emdash-frame-label" />
				</div>
				<div className="emdash-frame-sidebar-nav">
					{NAV_ITEMS.map((index) => (
						<div key={index} className="emdash-frame-sidebar-item">
							<div className="skeleton-line emdash-frame-icon" />
							<div className="skeleton-line emdash-frame-label" />
						</div>
					))}
				</div>
				<div className="emdash-frame-sidebar-footer">
					<div className="skeleton-line emdash-frame-icon emdash-frame-footer-trigger" />
					<div className="skeleton-line emdash-frame-label emdash-frame-footer-version" />
				</div>
			</div>
			<div className="emdash-frame-main">
				<div className="emdash-frame-header" aria-hidden="true">
					<div className="skeleton-line emdash-frame-icon emdash-frame-header-menu" />
					<div className="skeleton-line emdash-frame-button emdash-frame-view-site" />
					<div className="skeleton-line emdash-frame-button emdash-frame-theme" />
					<div className="skeleton-line emdash-frame-button emdash-frame-user" />
				</div>
				{children}
			</div>
		</div>
	);
}

/**
 * Removes the page's boot loader in the commit that first shows the admin, so
 * the page never paints between the two.
 */
export function useRemoveBootLoader() {
	React.useLayoutEffect(() => {
		document.getElementById("emdash-boot-loader")?.remove();
	}, []);
}
