---
"emdash": patch
---

Speeds up saving content in the admin on remote databases. A save through `PUT /_emdash/api/content/{collection}/{id}` reuses the entry, schema and draft revision it read for the permission check instead of reading them again, writes the revision and the draft pointer with `RETURNING`, and builds its response from the written row. A draft save on a revision-enabled collection drops from about 38 to 20 sequential database round trips before media-usage indexing.

The draft write is now also refused when the entry's `updated_at` changed since the save read it, not only its version, so a stale `_rev` cannot overwrite such a change.
