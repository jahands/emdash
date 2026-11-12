---
"emdash": patch
---

Fixes the Archives widget loading the publication date of every published post on each page view. The database now counts posts per day, and per second only on the first and last day of each month, so the widget reads far fewer rows. With 50,000 posts over ten years on PostgreSQL, the query returns 6,739 rows (273 KB) instead of 50,000 (2.1 MB), and grouping them takes about 2 ms instead of 13 ms. Months and years are still grouped in the server's local time zone, so archive links and counts don't change.
