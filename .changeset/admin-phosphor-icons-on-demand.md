---
"@emdash-cms/admin": patch
---

Reduces the JavaScript every admin screen downloads by about 1 MB gzip. Before, the admin shipped and ran all of the Phosphor icons on every screen, not just the ones it uses. Now it ships only its own icons. A plugin page or collection whose icon name isn't one of the built-in names still shows that icon. In that case the admin loads the full icon set on demand, and shows the default icon if the set can't load, for example offline.
