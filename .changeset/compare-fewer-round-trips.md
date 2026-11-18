---
"emdash": patch
---

Speeds up `GET /_emdash/api/content/{collection}/{id}/compare` on remote databases (PostgreSQL, Hyperdrive, D1). It reads the live and draft revisions in one query, together with the published references, so it waits on 2 database round trips instead of 5.
