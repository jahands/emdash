---
"emdash": minor
"@emdash-cms/admin": patch
---

Adds an optional comma-separated `fields` query parameter to the content list API to select which custom fields appear in each item's `data`. Requests without it still return all fields. The admin requests the fields needed by its configured list columns, reducing downloads for collections with large bodies; sites with plugins keep full entries available for extension columns.
