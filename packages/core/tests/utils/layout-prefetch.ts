import { startLayoutPrefetch } from "../../src/astro/prefetch.js";
import {
	getRequestContext,
	runWithContext,
	type EmDashRequestContext,
} from "../../src/request-context.js";

/**
 * Run `render` as one request for `route` the way the middleware does: start
 * the layout reads learned for the route, render, then let the prefetch learn
 * from the finished response.
 */
export async function renderWithLayoutPrefetch<T>(
	route: string,
	render: () => Promise<T>,
	ctx: EmDashRequestContext = { editMode: false },
): Promise<T> {
	return runWithContext(ctx, async () => {
		const prefetch = startLayoutPrefetch(ctx, route);
		const result = await render();
		await prefetch.settled;
		prefetch.trackResponse(new Response(null));
		return result;
	});
}

/**
 * Start the layout reads learned for `route` in the current request context
 * and wait for them, as if the render had not begun yet.
 */
export async function prefetchLayoutReads(route: string): Promise<void> {
	const ctx = getRequestContext();
	if (!ctx) throw new Error("prefetchLayoutReads needs a request context");
	await startLayoutPrefetch(ctx, route).settled;
}
