---
"emdash": patch
---

Speeds up `GET /_emdash/api/content/{collection}` on remote databases (PostgreSQL, Hyperdrive, D1). Each entry's SEO, bylines and pending draft are now read in the same statement as the page of entries, so the admin content list waits on one database round trip after authentication instead of two. Responses are unchanged.
