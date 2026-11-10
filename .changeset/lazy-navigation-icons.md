---
"@emdash-cms/admin": patch
---

Fixes unnecessary JavaScript downloads on admin pages by loading the full navigation icon vocabulary only when a plugin or collection requests an uncommon icon. Existing Phosphor icon names remain supported. If an uncommon icon fails to load, its default icon shows instead.
