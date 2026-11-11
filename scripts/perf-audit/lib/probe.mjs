/* oxlint-disable unicorn/consistent-function-scoping, e18e/prefer-static-regex -- these functions are serialized into the page, so helpers must live inside them */

/**
 * Code that runs inside the page. `installProbe` is passed to
 * `addInitScript`, so it must not close over anything in this module.
 */

export function installProbe() {
	const probe = {
		shifts: [],
		lcp: [],
		longTasks: [],
		events: [],
		paints: [],
	};
	window.__perfProbe = probe;

	const describe = (node) => {
		if (!node || node.nodeType !== 1) return node?.nodeName ?? null;
		const el = node;
		let label = el.tagName.toLowerCase();
		if (el.id) label += `#${el.id}`;
		const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/) : [];
		if (cls.length && cls[0]) label += `.${cls.slice(0, 3).join(".")}`;
		const role = el.getAttribute("role");
		if (role) label += `[role=${role}]`;
		const aria = el.getAttribute("aria-label");
		if (aria) label += `[aria-label="${aria.slice(0, 40)}"]`;
		const parts = [label];
		let parent = el.parentElement;
		for (let depth = 0; parent && depth < 3; depth++) {
			const name = parent.tagName.toLowerCase();
			parts.unshift(parent.id ? `${name}#${parent.id}` : name);
			parent = parent.parentElement;
		}
		const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
		return text ? `${parts.join(" > ")} "${text}"` : parts.join(" > ");
	};
	const rect = (r) => r && { x: r.x, y: r.y, width: r.width, height: r.height };

	const observe = (type, fn, extra = {}) => {
		try {
			new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({
				type,
				buffered: true,
				...extra,
			});
		} catch {
			// unsupported entry type
		}
	};

	observe("layout-shift", (entry) => {
		probe.shifts.push({
			value: entry.value,
			startTime: entry.startTime,
			hadRecentInput: entry.hadRecentInput,
			sources: (entry.sources ?? []).map((s) => ({
				node: describe(s.node),
				previousRect: rect(s.previousRect),
				currentRect: rect(s.currentRect),
			})),
		});
	});
	observe("largest-contentful-paint", (entry) => {
		probe.lcp.push({
			startTime: entry.startTime,
			renderTime: entry.renderTime,
			loadTime: entry.loadTime,
			size: entry.size,
			url: entry.url,
			element: describe(entry.element),
		});
	});
	observe("longtask", (entry) => {
		probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
	});
	observe("paint", (entry) => {
		probe.paints.push({ name: entry.name, startTime: entry.startTime });
	});
	observe(
		"event",
		(entry) => {
			probe.events.push({
				name: entry.name,
				startTime: entry.startTime,
				duration: entry.duration,
				processingStart: entry.processingStart,
				processingEnd: entry.processingEnd,
				interactionId: entry.interactionId,
			});
		},
		{ durationThreshold: 16 },
	);
}

/** Collect probe data plus every image on the page, loaded or not. */
export function collectProbe() {
	const probe = window.__perfProbe ?? {
		shifts: [],
		lcp: [],
		longTasks: [],
		events: [],
		paints: [],
	};
	const dpr = window.devicePixelRatio || 1;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const images = [];
	for (const img of document.querySelectorAll("img")) {
		const r = img.getBoundingClientRect();
		const style = getComputedStyle(img);
		const inViewport =
			r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
		images.push({
			src: img.currentSrc || img.src,
			alt: img.alt,
			complete: img.complete,
			visible: inViewport && style.visibility !== "hidden" && style.display !== "none",
			naturalWidth: img.naturalWidth,
			naturalHeight: img.naturalHeight,
			renderedWidth: r.width,
			renderedHeight: r.height,
			objectFit: style.objectFit,
			loading: img.getAttribute("loading"),
			fetchPriority: img.getAttribute("fetchpriority"),
			sizes: img.getAttribute("sizes"),
			srcset: img.getAttribute("srcset"),
		});
	}
	const resources = performance.getEntriesByType("resource").map((e) => ({
		name: e.name,
		serverTiming: (e.serverTiming ?? []).map((t) => ({ name: t.name, duration: t.duration })),
	}));
	const nav = performance.getEntriesByType("navigation")[0];
	return {
		...probe,
		dpr,
		viewport: { width: vw, height: vh },
		images,
		resources,
		navigationServerTiming: (nav?.serverTiming ?? []).map((t) => ({
			name: t.name,
			duration: t.duration,
		})),
		domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
		load: nav?.loadEventEnd ?? null,
	};
}

/**
 * Record the rectangles of visible, reasonably sized elements, tagging each
 * with a stable index so later samples can be compared. `exclude` is a CSS
 * selector for regions allowed to change.
 */
export function snapshotGeometry({ exclude, belowSelector } = {}) {
	// Position in scrolled content, so scrolling a container is not movement.
	const layoutRect = (el) => {
		const r = el.getBoundingClientRect();
		let x = r.x + window.scrollX;
		let y = r.y + window.scrollY;
		for (let p = el.parentElement; p; p = p.parentElement) {
			x += p.scrollLeft;
			y += p.scrollTop;
		}
		return { x, y, width: r.width, height: r.height };
	};
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const excluded = exclude ? [...document.querySelectorAll(exclude)] : [];
	const below = belowSelector
		? document.querySelector(belowSelector)?.getBoundingClientRect()
		: null;
	const tracked = [];
	let index = 0;
	for (const el of document.querySelectorAll("body *")) {
		if (tracked.length >= 400) break;
		if (excluded.some((ex) => ex === el || ex.contains(el))) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 24 || r.height < 12) continue;
		if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
		if (below && r.top >= below.top && r.left < below.right && r.right > below.left) continue;
		const style = getComputedStyle(el);
		if (style.position === "fixed" && style.zIndex !== "auto" && Number(style.zIndex) > 40)
			continue;
		const id = `g${index++}`;
		el.setAttribute("data-perf-geom", id);
		tracked.push({ id, rect: layoutRect(el) });
	}
	window.__perfGeometry = { tracked, moved: new Map(), running: true };
	const sample = () => {
		const state = window.__perfGeometry;
		if (!state?.running) return;
		for (const item of state.tracked) {
			const el = document.querySelector(`[data-perf-geom="${item.id}"]`);
			if (!el) continue;
			const r = layoutRect(el);
			if (r.width === 0 && r.height === 0) continue;
			const dx = Math.abs(r.x - item.rect.x);
			const dy = Math.abs(r.y - item.rect.y);
			const dw = Math.abs(r.width - item.rect.width);
			const dh = Math.abs(r.height - item.rect.height);
			const delta = Math.max(dx, dy, dw, dh);
			if (delta > 1) {
				const prev = state.moved.get(item.id);
				if (!prev || prev.delta < delta) {
					state.moved.set(item.id, {
						delta,
						dx,
						dy,
						dw,
						dh,
						at: performance.now(),
						el,
					});
				}
			}
		}
		requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
	return tracked.length;
}

/** Stop sampling and report elements that moved, outermost first. */
export function finishGeometry() {
	const state = window.__perfGeometry;
	if (!state) return { tracked: 0, moved: [] };
	state.running = false;
	const moved = [...state.moved.values()];
	const outermost = moved.filter(
		(m) =>
			!moved.some((other) => other !== m && other.el.contains(m.el) && other.delta >= m.delta - 1),
	);
	const describe = (el) => {
		let label = el.tagName.toLowerCase();
		if (el.id) label += `#${el.id}`;
		const role = el.getAttribute("role");
		if (role) label += `[role=${role}]`;
		const aria = el.getAttribute("aria-label");
		if (aria) label += `[aria-label="${aria.slice(0, 40)}"]`;
		const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
		return text ? `${label} "${text}"` : label;
	};
	for (const el of document.querySelectorAll("[data-perf-geom]"))
		el.removeAttribute("data-perf-geom");
	return {
		tracked: state.tracked.length,
		movedCount: moved.length,
		moved: outermost
			.toSorted((a, b) => b.delta - a.delta)
			.slice(0, 10)
			.map((m) => ({
				element: describe(m.el),
				delta: Math.round(m.delta),
				dx: Math.round(m.dx),
				dy: Math.round(m.dy),
				dw: Math.round(m.dw),
				dh: Math.round(m.dh),
				at: Math.round(m.at),
			})),
	};
}
