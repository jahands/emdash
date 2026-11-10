---
"emdash": patch
---

Makes the first search after a SQLite or D1 site starts much faster: checking the full-text indexes now takes three queries in total instead of seven per searchable collection. Missing or out-of-date indexes are still rebuilt before results are returned.
