---
"emdash": patch
"@emdash-cms/admin": patch
---

Makes the admin content list load with one request fewer. The list's response now carries the Trash tab's count, and the trash itself loads when its tab is opened. `GET /_emdash/api/content/{collection}` accepts `trashTotal=1` to include `trashTotal`, the number of trashed entries in the requested locale, for callers allowed to read the trash; the response is unchanged without it.
