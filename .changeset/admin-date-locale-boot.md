---
"@emdash-cms/admin": patch
---

Speeds up admin loading in languages other than English. The admin now requests its data while it loads the calendar locale, instead of afterwards. Calendars still use the locale's first day of the week.
