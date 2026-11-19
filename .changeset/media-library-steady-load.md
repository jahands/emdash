---
"@emdash-cms/admin": patch
---

Fixes the media library jumping while it loads. The toolbar, the media usage tracking banner, folders and the grid now appear together, so the "Media usage tracking is indexing existing content" banner and the folder loader no longer push the controls and media around. The banner also appears sooner, because the admin now requests the indexing progress at the same time as the setup status instead of after it.
