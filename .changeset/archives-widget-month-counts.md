---
"emdash": patch
---

Fixes the Archives widget loading the publication date of every published post on each page view. The database now counts posts per month and returns one row per month. With 50,000 posts on PostgreSQL, the widget's query returned 2 MB in about 250 ms; it now returns 4 KB in about 80 ms, or 16 ms with the new PostgreSQL list indexes.

The widget now groups posts by UTC month on every server. Before, it grouped them by the server process's local time zone. Cloudflare Workers and most Node.js hosts run in UTC, so their output is unchanged. On a Node.js server set to another time zone, a post published within that time zone's UTC offset of a month boundary now counts toward its UTC month.
