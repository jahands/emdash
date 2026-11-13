---
"emdash": minor
---

Adds an `ids` parameter to `GET /_emdash/api/media`, which returns up to 100 media items by ID in one request, in the order given and leaving out unknown IDs. It can't be combined with pagination or the list filters, and supports `includeUsage=1`.

```http
GET /_emdash/api/media?ids=01JA...,01JB...
```
