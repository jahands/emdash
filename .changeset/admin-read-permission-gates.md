---
"@emdash-cms/admin": patch
---

Fixes unnecessary permission-denied requests in the admin. Editors no longer request the admin-only user list or orphaned tables, and lower roles opening Redirects, Content Types, or Plugins see Access denied before those screens request protected data. Editor read access to these screens is preserved.
