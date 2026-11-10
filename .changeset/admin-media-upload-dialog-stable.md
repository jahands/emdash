---
"@emdash-cms/admin": patch
---

Fixes the media upload dialog jumping while files upload. The dialog keeps its top edge as the file list grows, its footer buttons keep their places, and the library behind it refreshes with the new uploads when the dialog closes instead of reshuffling after every file.
