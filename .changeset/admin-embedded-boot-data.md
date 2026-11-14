---
"emdash": patch
"@emdash-cms/admin": patch
---

Makes signed-in admin pages show their first screen sooner. The admin page now carries the manifest and the signed-in user, so screens start loading their data as soon as the admin's code runs instead of first waiting for `/_emdash/api/manifest` and `/_emdash/api/auth/me`. The page's head is still sent before that data is read, so the admin's code downloads in the meantime. Both endpoints are unchanged, and the admin still uses them to refresh after schema, settings or role changes.
