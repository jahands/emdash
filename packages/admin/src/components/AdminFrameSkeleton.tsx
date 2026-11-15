import * as React from "react";

const NAV_ITEMS = Array.from({ length: 8 }, (_, index) => index);

/**
 * The admin's frame as admin.astro renders it before the admin loads, shown
 * until the admin's data is ready. The page's own frame announces the loading.
 */
export function AdminFrameSkeleton() {
	return (
		<div className="emdash-frame" aria-hidden="true">
			<div className="emdash-frame-sidebar">
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
				<div className="emdash-frame-sidebar-footer" />
			</div>
			<div className="emdash-frame-main">
				<div className="emdash-frame-header" />
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
