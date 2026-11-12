---
"emdash": minor
---

Adds a `fields` parameter to `GET /_emdash/api/content/{collection}`, so API clients can list entries without downloading every field. Pass comma-separated field slugs, for example `?fields=title,excerpt`, and each item's `data` holds only those fields; system properties, SEO and bylines are unchanged. Without the parameter, the endpoint returns whole entries as before.
