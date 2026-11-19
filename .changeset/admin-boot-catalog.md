---
"emdash": patch
---

Speeds up every admin page load. The admin no longer waits about 300 ms before it requests data. Admin pages also no longer inline the translation catalog, which was about 300 KB on every page and was downloaded again on each reload. The page now preloads the catalog as a cached asset, so admin pages are under 30 KB and reloads reuse the catalog. Admin translation catalogs are no longer part of the server bundle.
