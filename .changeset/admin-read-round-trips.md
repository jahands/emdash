---
"emdash": patch
---

Speeds up admin loads on remote databases (PostgreSQL, Hyperdrive, D1) by running independent reads together. Opening an entry, the dashboard, the content list and the manifest each wait on fewer sequential database round trips, and admin pages no longer re-check setup state on every navigation once setup is complete.

`/_emdash/api/manifest` now sends an `ETag` with `Cache-Control: private, no-cache`, so the browser revalidates it on each load and gets a `304 Not Modified` when nothing changed. Any schema, plugin or settings change produces a new response immediately.
