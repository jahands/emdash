---
"@emdash-cms/admin": patch
---

Fixes clicking a taxonomy in the admin sidebar of a multilingual site reloading the whole admin. Admin links that carry a query string, such as the taxonomy links' `?locale=`, now open the screen in place, and their data starts loading on hover like other links.
