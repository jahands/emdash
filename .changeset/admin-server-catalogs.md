---
"@emdash-cms/admin": patch
---

Reduces the server bundle by about 2.5 MiB gzip. The visual editing toolbar and system emails now read small per-locale catalogs instead of loading whole admin translation catalogs. With the matching `emdash` release, the blog template's Worker upload fits within the Workers Free 3 MiB limit, and every admin locale still works.
