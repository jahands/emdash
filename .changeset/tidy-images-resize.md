---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes media thumbnails and editor image previews downloading original images when the Cloudflare adapter uses `imageService: 'cloudflare'` without an `IMAGES` binding. EmDash now sends these renditions through the zone's Cloudflare Image Resizing service. Image Resizing must be enabled on the zone; otherwise images fall back to their originals.
