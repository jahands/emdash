---
"emdash": patch
---

Speeds up the admin dashboard on sites with large collections. The entry counts per collection now come from existing indexes instead of reading every entry: with 50,000 posts, the count query drops from about 22 ms to 1.5 ms on SQLite and from about 10 ms to 4 ms on PostgreSQL.
