---
"@emdash-cms/admin": patch
---

Fixes the admin sidebar, header and Settings page jumping on first load. The admin now loads the signed-in user alongside the site configuration, so sections and links that depend on the user's role appear in place instead of being inserted after the page has drawn.
