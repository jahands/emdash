---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes responsive image candidates wider or taller than 4000 pixels being served as the full-size original on Cloudflare. The image endpoint now scales such a request down to fit within 4000 pixels, keeping its aspect ratio, and EmDash's generated `srcset` widths no longer exceed that size.
