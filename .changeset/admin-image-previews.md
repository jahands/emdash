---
"@emdash-cms/admin": patch
---

Fixes image fields moving the fields below them when previews load. Featured images request a small rendition after media metadata resolves, avoiding two original-size downloads while preserving refresh after replacement.
