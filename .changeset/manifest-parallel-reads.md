---
"emdash": patch
---

Speeds up the first admin screen on networked databases such as PostgreSQL: `GET /_emdash/api/manifest` now reads collections, fields, taxonomies, site options and the signup setting at the same time instead of one after another.
