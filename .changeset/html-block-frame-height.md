---
"@emdash-cms/admin": patch
---

Fixes an HTML block's preview briefly collapsing while it loads. The preview measured its height before its markup finished parsing, so it could shrink to nothing and grow back.
