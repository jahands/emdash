---
"emdash": patch
---

Saves no longer wait for media usage indexing once incremental capture is active. The database trigger that records the change also marks the collection's usage coverage stale, so the media library reports usage as out of date, never as unused, until the index catches up. The index is updated right after the response, and scheduled maintenance retries anything that does not finish. With capture active, a draft save drops from about 28 to 8 sequential database round trips.

If you read media usage straight after a write, for example in a script or test, expect the coverage status to be `stale` until the deferred update completes.
