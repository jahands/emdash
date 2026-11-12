---
"emdash": patch
---

Reduces the database work of the first request after a server start or a new Worker isolate. EmDash reads the applied-migration count, plugin states, collections, startup options, site settings and byline field definitions in one query, instead of one query each, and no longer clears stale cron task locks on startup, which every scheduled run already does. On the blog template, the first signed-out page view runs 5 queries instead of 12 to 15, and on PostgreSQL over Hyperdrive the runtime starts in one database round trip.
