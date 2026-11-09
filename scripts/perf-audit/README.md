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
