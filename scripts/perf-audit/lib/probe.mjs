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
 * Record the rectangles of visible, reasonably sized elements so later
 * samples can be compared.
 *
 * - `exclude`: a CSS selector for regions allowed to change.
 * - `grows`: a CSS selector for regions that grow by design, such as the
 *   paragraph being typed into or a grid that gains an item. They are
 *   tracked themselves, their contents reflow freely, and their growth is
 *   subtracted from the movement of elements below them and from the size
 *   of their ancestors.
 * - `within`: only track elements inside this element, such as an open
 *   dialog.
 * - `key`: names this sampler, so one can run inside another.
 */
export function snapshotGeometry({ exclude, grows, within, key = "default", limit = 1500 } = {}) {
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
	// Content starts at the inline-start edge, so a box that keeps that
	// edge and narrows from the other side was resized, not moved.
	const startEdgeShift = (before, after, rtl) =>
		rtl
			? Math.abs(after.x + after.width - (before.x + before.width))
			: Math.abs(after.x - before.x);
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const scope = within ? document.querySelector(within) : document.body;
	const excluded = exclude ? [...document.querySelectorAll(exclude)] : [];
	const growing = (grows ? [...document.querySelectorAll(grows)] : []).map((el, index) => ({
		el,
		index,
		rect: layoutRect(el),
	}));
	const isTrackable = (el, r) => {
		if (r.width < 24 || r.height < 12) return false;
		if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
		if (within) return true;
		const style = getComputedStyle(el);
		return !(style.position === "fixed" && style.zIndex !== "auto" && Number(style.zIndex) > 40);
	};
	const tracked = [];
	let truncated = false;
	for (const el of scope ? scope.querySelectorAll("*") : []) {
		if (excluded.some((ex) => ex === el || ex.contains(el))) continue;
		if (growing.some((g) => g.el !== el && g.el.contains(el))) continue;
		if (!isTrackable(el, el.getBoundingClientRect())) continue;
		if (tracked.length >= limit) {
			truncated = true;
			break;
		}
		const rect = layoutRect(el);
		tracked.push({
			el,
			rect,
			rtl: getComputedStyle(el).direction === "rtl",
			below: growing.filter(
				(g) =>
					!el.contains(g.el) &&
					rect.y >= g.rect.y + g.rect.height - 1 &&
					rect.x < g.rect.x + g.rect.width &&
					rect.x + rect.width > g.rect.x,
			),
			around: growing.filter((g) => g.el !== el && el.contains(g.el)),
		});
	}
	const state = {
		tracked,
		trackedSet: new Set(tracked.map((t) => t.el)),
		growing,
		scope,
		truncated,
		moved: new Map(),
		removed: new Map(),
		running: true,
	};
	window.__perfGeometry ??= {};
	window.__perfGeometry[key] = state;
	// An editor can re-render the block being typed into; find it again.
	const growth = (g) => {
		if (!g.el.isConnected) g.el = document.querySelectorAll(grows)[g.index] ?? g.el;
		return g.el.isConnected ? g.el.getBoundingClientRect().height - g.rect.height : 0;
	};
	const sample = () => {
		if (!state.running) return;
		const now = performance.now();
		for (const item of state.tracked) {
			const { el } = item;
			if (state.removed.has(el)) continue;
			const r = el.isConnected ? layoutRect(el) : null;
			if (!r || (r.width === 0 && r.height === 0)) {
				state.removed.set(el, {
					at: now,
					rect: item.rect,
					rtl: item.rtl,
					detached: !el.isConnected,
				});
				continue;
			}
			const shiftDown = item.below.reduce((sum, g) => sum + growth(g), 0);
			const grew = item.around.reduce((sum, g) => sum + growth(g), 0);
			const dx = startEdgeShift(item.rect, r, item.rtl);
			const dy = Math.abs(r.y - item.rect.y - shiftDown);
			const dw = Math.abs(r.width - item.rect.width);
			const dh = Math.abs(r.height - item.rect.height - grew);
			const delta = Math.max(dx, dy, dw, dh);
			if (delta > 1) {
				const prev = state.moved.get(el);
				if (!prev || prev.delta < delta) {
					state.moved.set(el, { el, delta, dx, dy, dw, dh, at: now });
				}
			}
		}
		requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
	return { tracked: tracked.length, truncated };
}

/**
 * Stop sampling and report elements that moved, outermost first, and
 * elements that disappeared. A disappeared element whose place was taken by
 * a new element is `replaced`; when the replacement sits elsewhere, that
 * counts as movement.
 */
export function finishGeometry(key = "default") {
	const state = window.__perfGeometry?.[key];
	if (!state) return { tracked: 0, moved: [], removed: [] };
	state.running = false;
	delete window.__perfGeometry[key];
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
	const describe = (el) => {
		let label = el.tagName.toLowerCase();
		if (el.id) label += `#${el.id}`;
		const role = el.getAttribute("role");
		if (role) label += `[role=${role}]`;
		const aria = el.getAttribute("aria-label");
		if (aria) label += `[aria-label="${aria.slice(0, 40)}"]`;
		const testId = el.getAttribute("data-testid");
		if (testId) label += `[data-testid=${testId}]`;
		const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
		return text ? `${label} "${text}"` : label;
	};
	const startEdgeShift = (before, after, rtl) =>
		rtl
			? Math.abs(after.x + after.width - (before.x + before.width))
			: Math.abs(after.x - before.x);
	const overlap = (a, b) => {
		const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
		const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
		if (w <= 0 || h <= 0) return 0;
		const inter = w * h;
		return inter / (a.width * a.height + b.width * b.height - inter);
	};

	const moved = [...state.moved.values()];
	const outermost = (list) =>
		list.filter(
			(m) =>
				!list.some((o) => o !== m && o.el.contains(m.el) && (o.delta ?? 0) >= (m.delta ?? 0) - 1),
		);

	const removedList = Array.from(state.removed.entries(), ([el, info]) => ({ el, ...info }));
	const outerRemoved = removedList.filter(
		(m) => !removedList.some((o) => o !== m && o.el.contains(m.el)),
	);
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const fresh = [];
	for (const el of state.scope && state.scope.isConnected
		? state.scope.querySelectorAll("*")
		: []) {
		if (state.trackedSet.has(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.width < 24 || r.height < 12) continue;
		if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
		fresh.push({ el, rect: layoutRect(el) });
	}
	const replaced = [];
	const removed = [];
	for (const gone of outerRemoved) {
		let best = null;
		for (const candidate of fresh) {
			const score = overlap(gone.rect, candidate.rect);
			if (score > 0.3 && (!best || score > best.score)) best = { ...candidate, score };
		}
		if (!best) {
			removed.push({
				element: describe(gone.el),
				detached: gone.detached,
				at: Math.round(gone.at),
			});
			continue;
		}
		const dx = startEdgeShift(gone.rect, best.rect, gone.rtl);
		const dy = Math.abs(best.rect.y - gone.rect.y);
		const dw = Math.abs(best.rect.width - gone.rect.width);
		const dh = Math.abs(best.rect.height - gone.rect.height);
		const delta = Math.max(dx, dy, dw, dh);
		if (delta > 1) {
			replaced.push({
				el: gone.el,
				replacement: describe(best.el),
				delta,
				dx,
				dy,
				dw,
				dh,
				at: gone.at,
			});
		}
	}
	const round = (m) => ({
		element: describe(m.el),
		...(m.replacement ? { replacedBy: m.replacement } : {}),
		delta: Math.round(m.delta),
		dx: Math.round(m.dx),
		dy: Math.round(m.dy),
		dw: Math.round(m.dw),
		dh: Math.round(m.dh),
		at: Math.round(m.at),
	});
	return {
		tracked: state.tracked.length,
		truncated: state.truncated,
		movedCount: moved.length,
		moved: [...outermost(moved), ...replaced]
			.toSorted((a, b) => b.delta - a.delta)
			.slice(0, 25)
			.map(round),
		removed: removed.slice(0, 25),
	};
}
