---
"@emdash-cms/admin": patch
---

Fixes the content editor's settings panel jumping on published entries. The Publish section now shows a "No draft changes" row, with Discard changes and Schedule unavailable until there are draft changes, so the first save no longer pushes every section below it down. The Ownership section keeps its place while the user list loads, and the editor no longer requests the user list for editors, who aren't allowed to read it.
