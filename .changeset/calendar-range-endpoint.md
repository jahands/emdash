---
"emdash": minor
"@emdash-cms/admin": patch
---

Adds `GET /_emdash/api/calendar/range`, which returns the first 1,000 published and scheduled entries in a calendar range in one response, with `truncated: true` when the range holds more. The admin Calendar now loads each month with this one request instead of up to ten paginated requests in a row, so months with many entries appear sooner. The paginated `GET /_emdash/api/calendar` endpoint is unchanged.
