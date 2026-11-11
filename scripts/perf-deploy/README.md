# Cloudflare deploy check

`pnpm perf:deploy` deploys the `templates/blog-cloudflare` site to your Cloudflare account, fills it with realistic content, measures it in a browser, and deletes everything it created. Use it to check behavior that only exists on Cloudflare's network: Image Resizing (`/cdn-cgi/image/...`), the `IMAGES` binding, cold starts, and D1 and R2 over the real network.

## Before you run it

- Log in with `pnpm --dir templates/blog-cloudflare exec wrangler login`. The check uses Wrangler's credentials and stores none of its own.
- Run `pnpm build` from the repository root. The site builds against this workspace's packages.
- Choose a hostname on a zone in the same account, such as `perf-check.example.com`. It must not have a DNS record yet. For URL mode, Image Resizing must be enabled on the zone.

## Run the check

```bash
pnpm perf:deploy --hostname perf-check.example.com
```

A run takes about 10 minutes, five of which are the idle gap before the second cold-start sample. It:

1. Creates a D1 database, an R2 bucket and a KV namespace for sessions, all named `emdash-perf-<run-id>`.
2. Builds the template with the chosen image service and `EMDASH_SITE_URL` set to the hostname, deploys it as the Worker `emdash-perf-<run-id>`, and attaches the hostname as a custom domain.
3. Completes the setup wizard as a new owner, registering a passkey with a virtual authenticator in Chromium. No development bypass is involved.
4. Uploads 10 generated photos and screenshots (1600–4000px, 0.6–3.7 MB) through the media API, sets them as featured images, and adds them to the two newest posts.
5. Opens the admin media library, the post editor, the home page and the newest post at 1440×900 (DPR 1) and 390×844 (DPR 3), scrolling each page to the bottom.
6. Times the first request to a logged-out page and to an admin API request after a fresh deploy and after an idle gap.
7. Deletes the custom domain, Worker, R2 bucket (emptied first), D1 database and KV namespace, then lists the account to confirm nothing with the run's prefix remains.

Results go to `.perf-audit/deploy/<run-id>/`: `summary.md` for reading, `results.json` with every measurement, a screenshot of each page, and `commands.log` with build and deploy output.

The check fails, and exits with code 1, when a media image is more than twice the size its box needs (rendered size × DPR) and larger than 50 KB, or when a media image fails to load. It exits with code 2 when a step errors.

## Options

| Option                   | Effect                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `--image-service <mode>` | `cloudflare` (default) uses URL mode through `/cdn-cgi/image`. `binding` uses `IMAGES`. |
| `--as-shipped`           | Builds without `EMDASH_SITE_URL`, exactly as the template ships.                        |
| `--account-id <id>`      | Selects the account when Wrangler can see more than one.                                |
| `--idle-gap <seconds>`   | Changes the wait before the idle cold-start sample. The default is 300.                 |
| `--keep`                 | Leaves the deployment running so you can inspect it.                                    |
| `--teardown <run-id>`    | Deletes the resources of a kept or interrupted run.                                     |

Without `EMDASH_SITE_URL` at build time, EmDash cannot authorize its media for Astro's image service, so public pages render original files; see [the `siteUrl` reference](../../docs/src/content/docs/reference/configuration.mdx).

## Cleaning up

Teardown runs when the check finishes, fails or is interrupted with Ctrl-C. Press Ctrl-C a second time to exit without waiting for it. To remove a kept or abandoned run:

```bash
pnpm perf:deploy --teardown <run-id>
```

Teardown deletes only what the run recorded in `.perf-audit/deploy/<run-id>/resources.json`. Before each deletion it checks that the resource carries the run's exact name, and that a custom domain points at the run's Worker, so it cannot remove anything the run did not create.
