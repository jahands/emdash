---
"@emdash-cms/admin": patch
---

Fixes failed loads appearing as empty data in Menus, Redirects, Widgets, taxonomy terms, and Comments. Failed screens keep the admin shell and offer Retry, including when an offline connection prevents a lazy screen from loading. Permission-denied requests no longer retry. When a screen's code is missing after a new deployment, the admin reloads the page once, after any save in progress has finished.
