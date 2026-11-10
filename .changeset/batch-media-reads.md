---
"emdash": minor
"@emdash-cms/admin": patch
---

Adds `GET /_emdash/api/media?ids=id1,id2` to read up to 100 media items with the same `media:read` permission as individual reads. Missing items are omitted from the returned `items` array. The admin coalesces concurrent media reads to reduce requests when opening image-heavy entries.
