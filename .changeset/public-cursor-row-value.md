---
"emdash": patch
---

Fixes later pages of `getEmDashCollection()` slowing down as the page number grows on PostgreSQL. A cursor page now starts reading the index at its cursor instead of filtering every earlier row, so a page 40,000 posts deep takes under a millisecond rather than several. Results are unchanged on every database.
