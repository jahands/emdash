---
"emdash": patch
---

Speeds up opening an entry in the editor on remote databases. Taking the edit lock (`POST /_emdash/api/content/{collection}/{id}/lock`) now reads only the entry row it authorizes against and gets the holder's name from the claim itself, cutting it from ten sequential database round trips to five. Reading an entry's terms (`GET .../terms/{taxonomy}`) makes one fewer.
