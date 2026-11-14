---
"emdash": patch
---

Speeds up the admin media library on remote databases: a numbered page of `GET /_emdash/api/media` reads its items and its total together instead of one after the other.
