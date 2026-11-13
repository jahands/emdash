---
"emdash": patch
---

Fixes signed-out page views on D1 and PostgreSQL over Hyperdrive running more database queries than the same page on Node.js. To overlap the layout's reads, EmDash started reading every menu, every widget area and every taxonomy's terms, whether or not the page showed them. It now starts only the site settings, menus, widget areas and term lists the route read on earlier requests, so a page runs the same queries as on Node.js. On Hyperdrive this also opens fewer connections per page view.
