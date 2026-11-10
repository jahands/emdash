# Perf audit

`pnpm perf:audit` measures layout shift, LCP, blocking time, API traffic, transfer size and server queries for every admin route, public fixture page and interaction scenario. It runs against a production build of `fixtures/perf-site`, with deterministic seed data, on a disposable database copy.

Run `pnpm build` first. Results go to `.perf-audit/results/<name>/` as `results.json` and `summary.md`; `.perf-audit/results/latest` points at the last run.

```bash
pnpm perf:audit                                        # every route and scenario, desktop and mobile
pnpm perf:audit --only admin:/media --viewport desktop # routes and scenarios containing the text
pnpm perf:audit --only 'admin:/$'                      # exact id; --list prints all ids
pnpm perf:audit --slow-api 800                         # loading-to-loaded transitions
pnpm perf:audit --hold /api/media --screenshots        # screenshot a loading state, then release it
pnpm perf:audit --cpu 4 --network slow4g               # Chrome CPU and network throttling
pnpm perf:audit --max-cls 0.02                         # exit non-zero over a CLS budget
pnpm perf:audit --baseline .perf-audit/results/x/results.json # before and after table
pnpm perf:audit --runs 2                               # report run-to-run agreement
```

After changing admin code, rebuild it with `pnpm --filter @emdash-cms/admin build`; the audit then rebuilds the site unless you pass `--skip-build`.

## Database latency

`--db-latency <ms>` adds a round-trip delay to every query by running a real PostgreSQL behind a small TCP proxy. It uses `EMDASH_TEST_PG` when set and otherwise creates a disposable local cluster with `initdb`, so PostgreSQL must be installed.

Compare against a 0ms run on the same database, using the same viewport and filter:

```bash
pnpm perf:audit --db postgres --viewport desktop --out pg-0
pnpm perf:audit --db-latency 20 --viewport desktop --baseline .perf-audit/results/pg-0/results.json --out pg-20
```

`summary.md` then ranks public pages, admin API endpoints and admin routes by added time. `waves` counts the sequential groups of queries in each request, so added time is roughly waves multiplied by latency.

Admin routes that need a plugin or marketplace are listed as unreachable in `summary.md`; the fixture does not configure them. `.perf-audit/` is gitignored.

## Role, language and theme

Use `--role editor|author|contributor|subscriber` to change the audit account on the disposable database. The default is `admin`. `--locale ar` sets the admin cookie and browser locale; `--dark` selects the dark color scheme. Arabic runs require Fontconfig and an Arabic system font, such as `fonts-noto-core`. The preflight rejects a missing Arabic fallback before measurements. Existing scenarios use English locators; use route measurements for Arabic until a scenario has locale-independent locators.

```bash
pnpm perf:audit --role editor --locale ar --dark --only 'admin:/settings$' --viewport desktop
```

Full navigations retain separate document snapshots in `results.json`. Merged event timestamps are relative to the earliest document's time origin. Document snapshots retain their local timestamps.

## Geometry and interaction scenarios

A scenario receives `captureGeometry(options)` and `assertVisibleState(before, after, tolerancePx = 1)`. The same functions are exported from the admin component-test `layout-stability.ts` utility. They compare column x/width, ordered row identities, container scroll offsets and window scroll. Pass `columns`, `rows` and `scroll` CSS selectors to select the relevant elements. Pass `identityAttribute` to use a stable row identifier instead of row text. Capture before an action and compare after settling or after returning with Back; do not compare different pages intentionally showing different rows.

```js
const before = await captureGeometry({ scroll: "main" });
await step("open last entry", () => page.locator("tbody a").last().click());
await step("back", () => page.goBack());
assertVisibleState(before, await captureGeometry({ scroll: "main" }));
```

`typeKeys(locator, text)` records script CPU time per character using CDP `Performance.getMetrics`, after two animation frames. Every scenario step also records script time, including its settle period, in `scriptSamples`. Document `events` contain Event Timing entries (Chromium's minimum reporting threshold is 16ms); fast keys may have no Event Timing entry. These are diagnostic samples, not machine-independent budgets.

Use `--query-timeline /content/posts` to export full SQL, request IDs, start timestamps and durations for matching request paths to a per-measurement `*-queries.json`. SQL is untruncated; parameters are not exported. Treat exported SQL as potentially sensitive. The ordinary query summary remains normalized.

## Initial JavaScript budget

`--max-initial-js-gz 500` fails when a route's initial JavaScript exceeds 500 KiB gzip. No default budget is imposed. `summary.md` includes a per-route table. The production build emits a graph of each chunk's static imports and gzip size; the harness starts from document module scripts and Astro island renderer/component entries, then walks only static imports, counting shared chunks once. Dynamic imports loaded during interactions are excluded. Rebuild once after upgrading this harness; an older build has no graph. Measured network transfer remains a separate metric.

## Cold processes and concurrency

`--cold` restarts the production Node process before each measurement, after TCP-only readiness. Authentication happens before the restart: the session persists on the disposable database, but server module state does not. This works with `--db postgres --db-latency 20`. `processReadyMs` reports spawn-to-listening separately from document TTFB and request query timelines. A scenario's first document is cold; later navigations in that scenario are warm. Deferred work is not classified as blocking: query logs currently flush at response completion and cannot reliably identify work scheduled after a response. Use raw timelines to investigate; do not call their total duration critical-path time.

Seed caches publish completed directories atomically. Concurrent first seeds can duplicate preparation but never consume another process's incomplete database. `--reseed` creates a new generation without deleting one an active run may be copying.

`--react-profile` rebuilds with `react-dom/profiling` and disables fixture minification. Each document snapshot includes committed React fiber render counts by component name and a commit count. This measures committed work; aborted renders are not counted. Profiling changes execution cost, so compare like-for-like profiling runs and use normal builds for latency budgets. It cannot be combined with `--skip-build`.

Category and tag fixtures paginate at 20 entries and fetch taxonomy terms without counts, matching the blog template's query behavior. Deliberate N+1/reference comparison pages are marked `fixtureOnly` in JSON and excluded from product ranking comparisons. They remain measured as diagnostic controls.

Run the harness regression checks with `node --test scripts/perf-audit/{metrics,documents,harness}.test.mjs` (requires installed Chromium). They deliberately move a table boundary by 31px, replace a row and change scroll, and require the assertions to reject each change. They also verify departed-document export, static import deduplication and concurrent seed publication. Audit scenario errors exit non-zero.

`query-counts` now chooses an available port, but its fixture build/database and D1 state are still shared within a checkout: serialize those runs. Separate worktrees have separate fixture state. The perf harness itself uses per-run databases and ports; avoid concurrent production rebuilds targeting the same database kind.

The search route asserts at least one result for the seeded `static` query. PostgreSQL currently has no implementation of the core SQLite FTS5 search backend, so this assertion fails there even with search metadata enabled. That failure is intentional coverage evidence; do not use an empty-result PostgreSQL run as a search throughput measurement. Implementing PostgreSQL search belongs in product code.

Storybook is not required for this workflow: Vitest browser tests cover component assertions, and the production harness covers real routes with held responses and screenshots.

The local PostgreSQL cluster manager also shares state within a checkout and can restart that cluster. Serialize local PostgreSQL audits, or use `EMDASH_TEST_PG` with an independently managed server. Its per-run database clones do not isolate the cluster lifecycle.

Use `--gzip` to put a local streaming gzip proxy in front of the Node fixture. JavaScript, CSS, HTML, JSON and SVG responses negotiate gzip, while images/fonts keep their existing encoding. Results record this deployment mode; CDP transfer bytes now reflect compression on the wire. Keep this option identical between comparisons. The proxy shares the audit process and adds local compression CPU overhead; it does not model a CDN cache or Brotli.

`--midpoint-ms 100` captures geometry and dialog rectangles 100ms after each scenario step starts, including its settle period. With `--screenshots`, it also captures that state. Samples appear in `transitionSamples` with their actual elapsed time. This is a timed checkpoint, not a guarantee of an animation's exact midpoint; raise the delay for longer transitions or use response gates for a specific loading state. The option defaults to 0 (disabled). Sampling adds measurement overhead, so enable it for visual diagnosis rather than final latency budgets.
