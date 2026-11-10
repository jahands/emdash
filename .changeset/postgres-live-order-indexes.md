---
"emdash": patch
---

Speeds up published content listings on PostgreSQL. A new migration adds partial indexes on `published_at` and `created_at` for entries that are not in the trash, so lists such as "latest posts" read the newest rows from an index instead of scanning and sorting the whole collection. SQLite and D1 already used an index for these lists and are unchanged.

On PostgreSQL the migration builds two indexes per collection. Building them blocks writes to that collection, but not reads, until the build finishes, which takes about 0.1 seconds per 50,000 entries.
