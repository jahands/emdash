/* Runs in every audited page before any app script. Keep it allocation-light: it shares the main thread with what it measures. */
const LEADING_SLASH = /^\//;
const SKIP_CLASS = /[:[\]/.!]/;

(() => {
	if (window.__perfAudit) return;

	const reactProfile = { commits: 0, renders: {} };
	if (window.__auditReactProfile)
		window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
			supportsFiber: true,
			inject: () => 1,
			onCommitFiberUnmount() {},
			onCommitFiberRoot(_renderer, root) {
				reactProfile.commits++;
				const visit = (fiber) => {
					if (!fiber) return;
					if (fiber.flags & 1 && typeof fiber.type === "function") {
						const name = fiber.type.displayName || fiber.type.name || "anonymous";
						reactProfile.renders[name] = (reactProfile.renders[name] ?? 0) + 1;
					}
					visit(fiber.child);
					visit(fiber.sibling);
				};
				visit(root.current);
			},
		};
	const shifts = [];
	const largestPaints = [];
	const longTasks = [];
	const timeline = [];
	const paints = {};
	let lastActivity = performance.now();
	let currentStep = "load";
	const documentId = crypto.randomUUID();
	const events = [];
	observe(
		"event",
		(entry) =>
			events.push({
				name: entry.name,
				t: entry.startTime,
				duration: entry.duration,
				processingMs: entry.processingEnd - entry.processingStart,
				interactionId: entry.interactionId,
				step: currentStep,
			}),
		{ durationThreshold: 16 },
	);

	function shortName(node) {
		if (!node || node.nodeType !== 1) return node?.nodeName?.toLowerCase() ?? "(none)";
		const classes = [...node.classList]
			.filter((name) => !SKIP_CLASS.test(name))
			.toSorted((a, b) => Number(b.startsWith("emdash")) - Number(a.startsWith("emdash")))
			.slice(0, 2);
		const label = node.getAttribute("aria-label");
		return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes.length ? `.${classes.join(".")}` : ""}${label ? `[aria-label="${label}"]` : ""}`;
	}

	function selectorOf(node) {
		if (!node) return "(removed)";
		let element = node.nodeType === 3 ? node.parentElement : node;
		if (!element || element.nodeType !== 1) return "(non-element)";
		const parts = [];
		while (element && parts.length < 5 && element !== document.documentElement) {
			let part = shortName(element);
			const siblings = element.parentElement
				? [...element.parentElement.children].filter((child) => child.tagName === element.tagName)
				: [];
			if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(element) + 1})`;
			parts.unshift(part);
			if (element.id) break;
			element = element.parentElement;
		}
		return parts.join(" > ");
	}

	function rectOf(rect) {
		return {
			x: Math.round(rect.x),
			y: Math.round(rect.y),
			width: Math.round(rect.width),
			height: Math.round(rect.height),
		};
	}

	function record(kind, detail, time = performance.now()) {
		timeline.push({ t: Math.round(time), kind, detail });
		lastActivity = Math.max(lastActivity, performance.now());
	}

	function observe(type, callback, extra) {
		try {
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) callback(entry);
			}).observe({ type, buffered: true, ...extra });
		} catch {
			// Entry type unsupported by this browser build.
		}
	}

	observe("layout-shift", (entry) => {
		lastActivity = performance.now();
		shifts.push({
			t: Math.round(entry.startTime),
			value: entry.value,
			hadRecentInput: entry.hadRecentInput,
			step: currentStep,
			sources: (entry.sources ?? []).map((source) => ({
				selector: selectorOf(source.node),
				text: (source.node?.textContent ?? "").trim().replaceAll(/\s+/g, " ").slice(0, 60),
				from: rectOf(source.previousRect),
				to: rectOf(source.currentRect),
			})),
		});
	});
	observe("largest-contentful-paint", (entry) => {
		largestPaints.push({
			t: Math.round(entry.startTime),
			size: entry.size,
			selector: selectorOf(entry.element),
			url: entry.url ? new URL(entry.url).pathname : undefined,
		});
	});
	observe("paint", (entry) => {
		paints[entry.name] = Math.round(entry.startTime);
	});
	observe("longtask", (entry) => {
		longTasks.push({
			t: Math.round(entry.startTime),
			duration: Math.round(entry.duration),
			step: currentStep,
		});
	});
	observe("resource", (entry) => {
		const url = new URL(entry.name, location.href);
		record("resource", `${entry.initiatorType} ${url.pathname}${url.search}`, entry.responseEnd);
	});

	const startDomObserver = () =>
		new MutationObserver((mutations) => {
			let added = 0;
			let removed = 0;
			let first;
			for (const mutation of mutations) {
				added += mutation.addedNodes.length;
				removed += mutation.removedNodes.length;
				if (!first && mutation.addedNodes[0]?.nodeType === 1) first = mutation.addedNodes[0];
			}
			if (added || removed) record("dom", `+${added}/-${removed} ${shortName(first)}`);
			else lastActivity = performance.now();
		}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
	if (document.documentElement) startDomObserver();
	else addEventListener("DOMContentLoaded", startDomObserver, { once: true });

	addEventListener(
		"load",
		(event) => {
			const { target } = event;
			if (target && target.tagName === "IMG") {
				record(
					"img",
					`${target.naturalWidth}x${target.naturalHeight} ${new URL(target.currentSrc || target.src).pathname}`,
				);
			}
		},
		true,
	);
	document.fonts?.addEventListener("loadingdone", (event) => {
		record(
			"font",
			Array.from(event.fontfaces, (face) => `${face.family} ${face.weight}`).join(", "),
		);
	});
	for (const type of ["pointerdown", "keydown"]) {
		addEventListener(
			type,
			(event) => {
				record("input", `${type} ${event.key ?? ""} ${shortName(event.target)}`);
			},
			true,
		);
	}
	for (const method of ["pushState", "replaceState"]) {
		const original = history[method];
		history[method] = function (...args) {
			record("nav", `${method} ${args[2]}`);
			return original.apply(this, args);
		};
	}

	window.__perfAudit = {
		mark(step) {
			currentStep = step;
			record("step", step);
		},
		idleFor: () => performance.now() - lastActivity,
		snapshot: () => ({
			reactProfile,
			language: document.documentElement.lang,
			direction: document.documentElement.dir,
			dark: matchMedia("(prefers-color-scheme: dark)").matches,
			entryScripts: [
				...document.querySelectorAll(
					'script[type="module"][src], astro-island[renderer-url], astro-island[component-url]',
				),
			]
				.flatMap((element) => [
					element.getAttribute("src"),
					element.getAttribute("renderer-url"),
					element.getAttribute("component-url"),
				])
				.filter(Boolean)
				.map((url) => new URL(url, location.href).pathname.replace(LEADING_SLASH, "")),
			documentId,
			timeOrigin: performance.timeOrigin,
			events,
			shifts,
			largestPaints,
			longTasks,
			timeline,
			paints,
			finalPath: location.pathname + location.search,
		}),
	};
	const archiveKey = "perf-audit-previous-document";
	try {
		const previous = sessionStorage.getItem(archiveKey);
		if (previous) {
			window.__auditFlushed = window.__auditDocument?.(JSON.parse(previous)).then(() => {
				if (sessionStorage.getItem(archiveKey) === previous) sessionStorage.removeItem(archiveKey);
				return undefined;
			});
		}
	} catch {
		/* Storage can be unavailable on opaque origins. */
	}
	addEventListener("pagehide", () => {
		const snapshot = window.__perfAudit.snapshot();
		try {
			sessionStorage.setItem(archiveKey, JSON.stringify(snapshot));
		} catch {
			/* The binding still covers documents with unavailable storage. */
		}
		window.__auditDocument?.(snapshot);
	});
})();
