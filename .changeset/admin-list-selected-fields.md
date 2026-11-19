---
"@emdash-cms/admin": patch
---

Makes content lists load faster by requesting only the fields they show (the title, a custom date field and configured list columns) instead of whole entries. When a plugin adds a column to the list, the list keeps requesting whole entries, because plugin cells receive the full entry.
