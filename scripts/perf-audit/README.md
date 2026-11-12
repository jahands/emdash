# Perf audit

`pnpm perf:audit` builds the shipped templates for the platforms EmDash runs on in production, fills them with owner-style content, and measures the admin and public screens in Chromium. It reports layout shifts with attribution, paint and blocking time, API and database work, oversized images, build output, and cold starts.

Everything runs locally. Nothing is deployed and no real accounts are used.

## Run it

Install dependencies and build the packages first, from the repository root:

```bash
pnpm install
pnpm build
pnpm perf:audit
```

The default run takes the blog template through five profiles at desktop (1440×900, 2x) and mobile (390×844, 3x) sizes. Results go to `.perf-audit/results/<run>/`:

- `summary.md` ranks the worst screens and lists oversized images, build output, bundle composition, cold starts, interaction scenarios, writes, duplicate queries, query plans, restores and budget failures.
- `results.json` has every measurement, including request waterfalls, layout-shift sources and the SQL of each replayed request.
- `logs/` has the build and server output for each profile.
- `screenshots/` has screenshots of this workspace, and `screenshots-compare/` those of the `--compare` workspace.

The Postgres profiles need `initdb` and `pg_ctl` on your `PATH`, or `EMDASH_TEST_PG` set to a connection string for a role that can create databases.

## Profiles

A profile is a template plus a platform. Run `pnpm perf:audit --list` to see them all.

| Platform                      | Runtime                      | Database                                             | Images                                   |
| ----------------------------- | ---------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `node-sqlite`                 | `node dist/server/entry.mjs` | SQLite file                                          | sharp                                    |
| `node-postgres`               | Node                         | PostgreSQL through a latency proxy                   | sharp                                    |
| `workerd-d1`                  | `astro preview` (workerd)    | local D1, local R2                                   | Images binding (adapter default)         |
| `workerd-d1-url-images`       | workerd                      | local D1, local R2                                   | `imageService: "cloudflare"`, no binding |
| `workerd-postgres`            | workerd                      | Hyperdrive `localConnectionString` through the proxy | Images binding                           |
| `workerd-postgres-url-images` | workerd                      | Hyperdrive                                           | URL mode                                 |

The default set is the blog on the first five platforms. `--profiles all` adds the portfolio, marketing and starter templates and the Hyperdrive URL-mode variant.

Each site is copied from `templates/<name>` (Node) or `templates/<name>-cloudflare` (workerd) into `.perf-audit/work/<slot>/sites/<profile>/`. Only platform settings change: `siteUrl`, the database, the image service, and the matching wrangler bindings. Pages and seed are untouched. The changed config is saved as `perf-audit.astro.config.mjs`, and `astro.config.mjs` imports it and turns on hidden source maps (`vite.build.sourcemap: "hidden"`). Hidden maps don't change the emitted code, not even with a `sourceMappingURL` comment; the harness reads them to attribute bundle bytes. The site's `node_modules` links to the template's own dependencies in the workspace, plus `sharp` for Node, which npm would hoist for a real site. Because that link could hide a packaging bug, each build is also checked as shipped: when the built server imports a linked package that the template does not declare and install itself, the summary lists it under **Product findings**.

## What the content looks like

Each profile starts empty and is set up the way an owner would set it up:

1. The setup wizard routes apply the template seed.
2. The first admin is created through the setup routes, with a Chromium virtual authenticator answering the passkey prompt.
3. The owner uploads 12 generated photos and screenshots (1600–4000 px, 0.6–3.5 MB) through the media library.
4. Every entry gets a featured image and an image in its body. One long entry gets a featured image and all 12 uploads as distinct image blocks in its body, and 52 more entries with two body images each make the lists paginate. The seed reads the long entry back and stops when it does not hold those 13 images. A draft essay of about 30,000 words in 600 paragraphs, with no images, is the document the typing scenario edits.
5. Media usage tracking is switched on and left indexing. No media folders are created.

With `--seed-size large`, the harness then writes 50,000 more entries into the same collection with batched SQL, which takes seconds. Each has a title, excerpt, featured image, a short body and a term. Dates spread over six years, with more entries in recent years. 78% are published, 12% drafts, 4% scheduled and 6% in the trash. 88% are English; the French (8%) and German (4%) entries are translations that share an English entry's slug and translation group. Postgres tables are analyzed afterwards, as autovacuum would. Query-plan problems only show at this size. Prepared sites remember their seed size, so `--reuse` never mixes the two.

Production builds return 403 from the dev bypass, so the harness signs in by writing a magic-link token row, the same row `createMagicLinkUrl()` writes, and posting it to `/_emdash/api/auth/magic-link/verify`.

The state is then snapshotted: the database, uploads and sessions, or `.wrangler/state` for workerd. When a measurement writes state, either declared by the scenario or seen as a write in the query log, the next measurement restores the snapshot first. Restores are listed in the summary.

## What is measured

The screens are the admin dashboard, each collection's list, the long entry's editor, a new entry, the collection's content type, media, every settings page, menus, the taxonomy, users, calendar, comments, bylines and the byline schema, content types and relations, redirects, widgets, sections, plugins, the WordPress importer, and the signed-out login page; then the public home, the long entry and an archive. The plugin and theme marketplaces are left out because they load from external registries.

For each screen:

- CLS with Chrome's session windows, plus the elements that moved, by how much, and when
- LCP, FCP and total blocking time, in Chromium's new headless mode so paint timing is real
- API requests, their bytes, the time to the last API response, and API waves (calls that waited for an earlier response)
- the time from the last script that finished before the first API request to that request, which shows main-thread work or idle waiting between loading the admin and asking for data
- scripts and stylesheets on the critical path that the browser only found by parsing another script, with the chain that led to each. The critical path ends at the screen's first API request, or at `load` on public pages.
- the request waterfall, with the request each one waited on and how that is known: the initiator Chromium recorded, or, for an API call issued right after another API response, a guess from timing, labelled `inferred-timing`. Chromium does not record which response a script awaited, so hold the request (`--hold`) to prove a dependency.
- transfer bytes by resource type, and the transfer if every text response that arrived without `Content-Encoding` were sent at its brotli-5 size, as a CDN would send it. Local `wrangler dev` never compresses, so on workerd profiles the second figure is closer to a deployed Worker.
- every image on the page, as painted in the viewport, loaded but outside it, failed, or not loaded (lazy). Painted images are flagged when they have more than twice the pixels the screen needs (rendered size × device pixel ratio) and cost over 50 KiB. Pixels are the selected file's own dimensions: the harness fetches each image's `currentSrc` again and reads its header, because `naturalWidth` is divided by the `srcset` density (a 2560 px file picked for an 1136 px slot reports 1136). For `object-fit: cover` only the uncropped side counts.

After each page load, the page's GET document and API requests are replayed one at a time. Documents are replayed with the `Accept` header Chromium sends for a navigation, because EmDash serves HTML navigations differently, for example by starting a page's layout reads early. The query log (`EMDASH_QUERY_LOG=1`) gives the queries per request, kept in `results.json` as SQL normalized the way `scripts/query-counts` normalizes it. The summary lists statements a request ran more than once, and how many of those runs had identical parameters (the same work twice) rather than different ones (an N+1 read). On Postgres profiles the latency proxy also records round trips, new connections, and sequential waves.

The write pass then sends, with the owner's session: create an entry, save, autosave and publish the image-heavy entry, move the new entry to the trash, upload a photo and delete it. Each write records its TTFB, queries, repeated statements, and on Postgres its round trips and waves. It also records work done after the response, such as `after()` callbacks: the harness waits until the database has been quiet for 500 ms, then reports how long the work ran, and its round trips on Postgres or the commits it saw on SQLite and D1. Commits are read from the database file, only when it is in WAL mode, where reading never blocks the server's writes.

On Postgres profiles, the list, count, archive and sitemap queries are captured from real requests (the public screens, the admin list API, the dashboard and the sitemaps) and run again under `EXPLAIN ANALYZE` on a direct connection. A plan is flagged when it scans a table of 10,000 rows or more sequentially, or sorts 10,000 rows or more. The default seed is too small to reach that; use `--seed-size large`.

For each profile:

- server bundle files, bytes and gzip bytes; for workerd, what `wrangler deploy --dry-run` would upload
- the largest packages in the server bundle, read from rolldown's region markers
- bundle composition: the admin's initial JavaScript and the server bundle attributed to packages and modules through the source maps. A workspace package's own source map is followed one more level, so `packages/admin` shows its source files. Indentation and lines between mapped code count toward the code around them; the rest, such as a chunk's imports, is listed as unmapped.
- the startup import closure of the server entry
- client asset count, and the gzip size of the admin document's initial JavaScript
- cold starts: the runtime is restarted before the first public page and again before the first admin API request, three times each; the median is reported
- cold-start bursts: the runtime is restarted, then at least 15 signed-out page requests are sent at once, and again with at least 15 signed-in admin API requests mixed in, twice each (`--burst-rounds <n>` changes that). Any response that is not 2xx or 3xx fails the run. Workerd answers a request it cancelled with a 500 and logs nothing, so the summary lists failed responses separately from server errors.

Interaction scenarios sample element positions with `requestAnimationFrame` and fail when a visible element moves. Scrolling a container does not count, and neither do overlays that appear on top. An element that is removed counts as moved when a new element takes its place somewhere else; one removed with nothing in its place is listed separately. Regions that grow by design are measured rather than skipped: while typing, the paragraph being edited may grow and everything below it may move down by exactly that much. The media grid may grow when it gains an upload, but the tiles already in it must stay where they were, so an upload added at the start of the grid fails the scenario. Only growth is allowed for: a region that shrinks moves what is below it. When the command palette, the upload dialog or the phone menu opens, the scenario screenshots it while it is open and samples positions inside it while it settles.

Scenarios find controls by role, form structure and URL, and by the admin's own message catalog for the run's locale, so they behave the same under `--locale ar`. Error and status feedback is detected from new `alert` and `status` regions, not English wording. Each scenario records the machine's CPU use and load average while it ran. The scenarios cover typing in the long essay (input-to-frame time per keystroke, and long tasks, run twice with the faster run reported and both kept), autosave and save, a failed save, a save conflict, the command palette and a dialog, selecting and deselecting rows in a list, moving between admin sections, the phone menu, uploading media, a failed API request, and navigating while offline.

URL-mode profiles serve `/cdn-cgi/image/...`, which `wrangler dev` does not implement, from a Playwright route that resizes with sharp. Those responses carry `x-perf-audit-emulated: cdn-cgi-image`, and the summary marks them as emulated. The emulation follows Cloudflare's documented options for the URLs Astro's Cloudflare image service and EmDash generate:

- `fit`: `scale-down` (the default), `contain`, `cover`, `crop`, `aspect-crop`, `pad` (white background unless `background` is set), `squeeze` and `scale-up` give Cloudflare's output dimensions. A single `width` or `height` scales the other side proportionally.
- `dpr` multiplies the requested size, up to 2. `quality` defaults to 85. `format=auto` follows the `Accept` header; without `format` the source format is kept.
- `onerror=redirect` redirects to the source when the transform fails.
- Responses carry the source's `Cache-Control`, `ETag` and `Last-Modified`, as Cloudflare's variants follow the source's caching rules, and conditional requests are passed to the source.

It differs from Cloudflare in these ways:

- Bytes come from sharp's encoders, so image byte counts are close but not Cloudflare's. AVIF never falls back to WebP or JPEG.
- There is no edge cache, so the one-hour minimum edge lifetime is not applied. Every request fetches and transforms the source again.
- `gravity` (crops are centered) and the effect options (`blur`, `sharpen`, `rotate` and the like) are ignored. A page that used one lists it under `resizeEmulation.ignoredOptions` in `results.json`.
- Zone settings and authorization are not checked, and only `/cdn-cgi/image` is emulated. EmDash's own `/_image` endpoint runs unchanged.
- Playwright routes never see the target of a redirect. When `/_image` redirects into `/cdn-cgi/image`, as EmDash's URL-mode endpoint does, the `/_image` request is answered with the emulated rendition, so the redirect's round trip is not measured. `resizeEmulation.redirected` in `results.json` counts these.

## Common options

```bash
# One profile, a few screens and the scenarios that match, desktop only
pnpm perf:audit --profile blog-workerd-d1 --only media --only editor --viewport desktop

# Only the write pass and the query plans, on a large seed
pnpm perf:audit --profile blog-node-postgres --seed-size large --only write --only plan

# Reuse prepared sites while iterating on the harness or a measurement
pnpm perf:audit --profile blog-node-sqlite --reuse

# Compare this checkout with a main worktree
pnpm perf:audit --compare ../emdash-main

# Fail when over budget
pnpm perf:audit --max-cls 0.05 --max-server-gz 6000 --max-initial-js-gz 2500 --max-oversized-images 0

# Fail when a workerd profile's Worker upload is over the Workers Free 3 MiB limit
pnpm perf:audit --profile blog-workerd-d1 --max-upload-gz 3072
```

`--only` selects screens and scenarios whose name or path contains the text. Text starting with `write` selects the write pass and text starting with `plan` the query plans; both run when there is no `--only`. Cold starts still run unless `--skip-cold-start` is set.

`--workspace <dir>` builds the sites against another checkout's packages. `--compare <dir>` runs the same profiles against a second checkout and prints a before/after table. A row is a regression when:

- CLS rises by more than 0.01, server gzip by more than 5%, API requests by more than 1, image bytes by more than 20%, or a cold start by more than 25%
- a screen has more late-discovered scripts and stylesheets
- typing's input-to-frame p95 is over 50 ms and more than 25% above the other workspace's faster run in both of this workspace's runs. The row notes the machine's CPU use in each workspace.
- a write runs at least one more query, has at least one more DB wave, makes at least one more round trip during and after the response together, or its TTFB rises by more than 20% and 10 ms. Round trips after the response are shown but not flagged on their own, because moving work into `after()` is how a write gets faster.

The table also shows each screen's JS-done-to-first-API time, which is never flagged because it moves with machine load. When bundle composition changes, the summary lists each package that grew or shrank by 2 KiB or more, so a growing bundle names its cause. Change the thresholds with `--threshold-cls`, `--threshold-server-gz`, `--threshold-api`, `--threshold-image-bytes`, `--threshold-cold-start`, `--threshold-write-queries`, `--threshold-write-waves` and `--threshold-write-ttfb`.

Layout races, cold starts and write timings vary between runs of the same code, so each first-pass regression is measured twice more in both workspaces and judged on the median of three. Differences that don't hold up are listed separately in the summary. Set the number of extra samples with `--confirm-samples` (0 turns confirmation off).

Both workspaces need `pnpm install` and `pnpm build`. The compare workspace's sites live in `.perf-audit/work/<slot>/compare/`.

`--reuse` skips building and seeding when the workspace commit matches the prepared site and its ports are still free. Uncommitted package changes are not detected, so rebuild without `--reuse` after editing packages.

## Running in parallel

Runs with different `--run` names can run at the same time, from one checkout or several. Each run gets:

- its own slot, `.perf-audit/work/<slot>/`, holding the sites, state snapshots, the PostgreSQL cluster and scratch files. The slot is the `--sites` name, else the `--run` name, else `default`.
- ports leased machine-wide for each site, its Postgres latency proxy and its PostgreSQL cluster. A prepared site keeps its ports because its origin is built in; if another run took them, the site is prepared again.
- its own results folder and a fresh Chromium profile.

A run that needs a slot or results folder another run holds waits, and prints what it is waiting for and who holds it. Workerd starts take turns machine-wide for a few seconds each, because the Cloudflare Vite plugin picks its inspector port while it starts.

```bash
pnpm perf:audit --run media-pg --profile blog-node-postgres --only media &
pnpm perf:audit --run media-d1 --profile blog-workerd-d1 --only media &
wait

# Several result folders over one prepared site
pnpm perf:audit --sites base --run held --reuse --hold /_emdash/api/
```

There is no need to wrap runs in an outer lock such as `flock`. Concurrent runs share the CPU, though, so their timings and cold starts are noisier, and the summary says how many other runs were active. Run alone when timings matter, for example for `--compare` or a timing budget. If you do serialize runs with a lock, say so before waiting on it, so nobody mistakes a queued run for a hung one:

```bash
flock -n "$LOCK" pnpm perf:audit ... || { echo "waiting for $LOCK"; flock "$LOCK" pnpm perf:audit ...; }
```

## Debugging

| Option                    | Effect                                                                                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--screenshots`           | Save every screen to `screenshots/<profile>/<viewport>/`                                                                                                                                                         |
| `--hold <url-text>`       | Hold matching requests and screenshot the loading state                                                                                                                                                          |
| `--hold-after <url-text>` | With `--hold`, hold only requests made after a response matching this text arrived (repeatable)                                                                                                                  |
| `--hold-after-boot`       | With `--hold`, on signed-in admin screens, hold only requests made after the admin's boot requests (manifest and `auth/me`) were answered, so the screenshot shows the screen loading instead of the boot loader |
| `--slow-api <ms>`         | Delay every API response                                                                                                                                                                                         |
| `--cpu <n>`               | Slow the CPU down by a factor of `n`                                                                                                                                                                             |
| `--network slow4g`        | Throttle to 150 ms RTT, 1.6 Mbps down, 750 kbps up                                                                                                                                                               |
| `--db-latency <ms>`       | Round-trip latency in front of Postgres (default 20)                                                                                                                                                             |
| `--locale ar`             | Use the Arabic admin                                                                                                                                                                                             |
| `--dark`                  | Use the dark color scheme                                                                                                                                                                                        |
| `--skip-writes`           | Skip the write pass                                                                                                                                                                                              |

The summary notes when `--hold`, `--slow-api`, `--cpu` or `--network` distorted the timings. Scenario screenshots are always saved.

For Arabic runs, point fontconfig at a config that provides Arabic fonts instead of installing fonts globally:

```bash
FONTCONFIG_FILE=/path/to/arabic-fonts.conf pnpm perf:audit --locale ar
```

## Limits

- DB waves need the latency proxy, so only Postgres profiles report them. SQLite and D1 report query counts.
- Work after a write's response is counted from the latency proxy (Postgres) or commits seen in the database file (SQLite and D1). Commits are polled, so two that land within a few milliseconds count as one. The query log stops at the response, so queries made after it are not in the write's query count or SQL.
- Cold starts on local workerd include isolate start-up on this machine, which is not the same as Cloudflare's edge. Compare them between runs, not with production numbers.
- Node's standalone server does not compress responses. Transfer bytes on Node profiles are what a site without a compressing proxy sends.
- The template seeds download their images from Unsplash during setup, so setup needs network access.

## Tests

```bash
node --test scripts/perf-audit/tests/*.test.mjs
```

The tests cover profile materialization against the real templates, port leasing and slot locks, the seeded image counts, the as-shipped dependency check, reading the admin message catalog, CLS session windows, blocking time, oversized-image detection on decoded pixels, image states, waves, the resize emulation against Cloudflare's documented examples, budgets and comparison, restore bookkeeping, the latency proxy, argument parsing, `--only` matching, hold triggers, duplicate queries, write and typing comparison, best-of-runs, late discovery, source-map decoding and attribution, the large seed's rows, and plan flags. They also run as part of `pnpm test:unit`.
