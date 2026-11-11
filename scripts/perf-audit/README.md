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

- `summary.md` ranks the worst screens and lists oversized images, build output, cold starts, interaction scenarios, restores and budget failures.
- `results.json` has every measurement, including request waterfalls and layout-shift sources.
- `logs/` has the build and server output for each profile.

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

Each site is copied from `templates/<name>` (Node) or `templates/<name>-cloudflare` (workerd) into `.perf-audit/work/<slot>/sites/<profile>/`. Only platform settings change: `siteUrl`, the database, the image service, and the matching wrangler bindings. Pages and seed are untouched. The site's `node_modules` links to the template's own dependencies in the workspace, plus `sharp` for Node, which npm would hoist for a real site.

## What the content looks like

Each profile starts empty and is set up the way an owner would set it up:

1. The setup wizard routes apply the template seed.
2. The first admin is created through the setup routes, with a Chromium virtual authenticator answering the passkey prompt.
3. The owner uploads 12 generated photos and screenshots (1600–4000 px, 0.6–3.5 MB) through the media library.
4. Every entry gets a featured image and an image in its body. One long entry gets a featured image and all 12 uploads as distinct image blocks in its body, and 52 more entries with two body images each make the lists paginate. The seed reads the long entry back and stops when it does not hold those 13 images.
5. Media usage tracking is switched on and left indexing. No media folders are created.

Production builds return 403 from the dev bypass, so the harness signs in by writing a magic-link token row, the same row `createMagicLinkUrl()` writes, and posting it to `/_emdash/api/auth/magic-link/verify`.

The state is then snapshotted: the database, uploads and sessions, or `.wrangler/state` for workerd. When a measurement writes state, either declared by the scenario or seen as a write in the query log, the next measurement restores the snapshot first. Restores are listed in the summary.

## What is measured

For each screen:

- CLS with Chrome's session windows, plus the elements that moved, by how much, and when
- LCP, FCP and total blocking time, in Chromium's new headless mode so paint timing is real
- API requests, their bytes, the time to the last API response, and API waves (calls that waited for an earlier response)
- the request waterfall, with the request each one waited on
- transfer bytes by resource type
- every image on the page, as painted in the viewport, loaded but outside it, failed, or not loaded (lazy). Painted images are flagged when they have more than twice the pixels the screen needs (rendered size × device pixel ratio) and cost over 50 KiB. Pixels are the selected file's own dimensions: the harness fetches each image's `currentSrc` again and reads its header, because `naturalWidth` is divided by the `srcset` density (a 2560 px file picked for an 1136 px slot reports 1136). For `object-fit: cover` only the uncropped side counts.

After each page load, the page's GET document and API requests are replayed one at a time. The query log (`EMDASH_QUERY_LOG=1`) gives the query count per request. On Postgres profiles the latency proxy also records round trips, new connections, and sequential waves.

For each profile:

- server bundle files, bytes and gzip bytes; for workerd, what `wrangler deploy --dry-run` would upload
- the largest packages in the server bundle, read from rolldown's region markers
- the startup import closure of the server entry
- client asset count, and the gzip size of the admin document's initial JavaScript
- cold starts: the runtime is restarted before the first public page and again before the first admin API request, three times each; the median is reported

Interaction scenarios sample element positions with `requestAnimationFrame` and fail when a visible element moves. Scrolling a container does not count, and neither do overlays that appear on top. The scenarios cover typing in the long entry (input-to-frame time per keystroke), autosave and save, a failed save, a save conflict, the command palette and a dialog, moving between admin sections, the phone menu, uploading media, a failed API request, and navigating while offline.

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

## Common options

```bash
# One profile, a few screens, desktop only
pnpm perf:audit --profile blog-workerd-d1 --only media --only editor --viewport desktop

# Reuse prepared sites while iterating on the harness or a measurement
pnpm perf:audit --profile blog-node-sqlite --reuse

# Compare this checkout with a main worktree
pnpm perf:audit --compare ../emdash-main

# Fail when over budget
pnpm perf:audit --max-cls 0.05 --max-server-gz 6000 --max-initial-js-gz 2500 --max-oversized-images 0
```

`--workspace <dir>` builds the sites against another checkout's packages. `--compare <dir>` runs the same profiles against a second checkout and prints a before/after table. A row is a regression when CLS rises by more than 0.01, server gzip by more than 5%, API requests by more than 1, image bytes by more than 20%, or a cold start by more than 25%. Change the thresholds with `--threshold-cls`, `--threshold-server-gz`, `--threshold-api`, `--threshold-image-bytes` and `--threshold-cold-start`.

Layout races and cold starts vary between runs of the same code, so each first-pass regression is measured twice more in both workspaces and judged on the median of three. Differences that don't hold up are listed separately in the summary. Set the number of extra samples with `--confirm-samples` (0 turns confirmation off).

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

| Option              | Effect                                                   |
| ------------------- | -------------------------------------------------------- |
| `--screenshots`     | Save every screen to `screenshots/<profile>/<viewport>/` |
| `--hold <url-text>` | Hold matching requests and screenshot the loading state  |
| `--slow-api <ms>`   | Delay every API response                                 |
| `--cpu <n>`         | Slow the CPU down by a factor of `n`                     |
| `--network slow4g`  | Throttle to 150 ms RTT, 1.6 Mbps down, 750 kbps up       |
| `--db-latency <ms>` | Round-trip latency in front of Postgres (default 20)     |
| `--locale ar`       | Use the Arabic admin                                     |
| `--dark`            | Use the dark color scheme                                |

The summary notes when `--hold`, `--slow-api`, `--cpu` or `--network` distorted the timings. Scenario screenshots are always saved.

For Arabic runs, point fontconfig at a config that provides Arabic fonts instead of installing fonts globally:

```bash
FONTCONFIG_FILE=/path/to/arabic-fonts.conf pnpm perf:audit --locale ar
```

## Limits

- DB waves need the latency proxy, so only Postgres profiles report them. SQLite and D1 report query counts.
- Cold starts on local workerd include isolate start-up on this machine, which is not the same as Cloudflare's edge. Compare them between runs, not with production numbers.
- Node's standalone server does not compress responses. Transfer bytes on Node profiles are what a site without a compressing proxy sends.
- The template seeds download their images from Unsplash during setup, so setup needs network access.

## Tests

```bash
node --test scripts/perf-audit/tests/*.test.mjs
```

The tests cover profile materialization against the real templates, port leasing and slot locks, the seeded image counts, CLS session windows, blocking time, oversized-image detection on decoded pixels, image states, waves, the resize emulation against Cloudflare's documented examples, budgets and comparison, restore bookkeeping, the latency proxy, and argument parsing. They also run as part of `pnpm test:unit`.
