---
"emdash": patch
---

Speeds up reading content in the admin on remote databases. The single-entry and list endpoints now load SEO, bylines, references and draft data at the same time, so `GET /_emdash/api/content/{collection}/{id}` makes three sequential database round trips instead of eleven.
