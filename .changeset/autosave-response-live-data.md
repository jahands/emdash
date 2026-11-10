---
"emdash": minor
"@emdash-cms/admin": patch
---

Adds an optional `includeLiveData=false` query parameter to content updates to omit the published copy of an entry from the response. Existing callers still receive the full response. Admin autosaves use this option to reduce downloads while retaining the published copy already cached by the editor.
