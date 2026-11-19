---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Fixes media renditions on Workers sites that use `imageService: "cloudflare"` (URL-based transformations, no `IMAGES` binding). Admin thumbnails and other `/_image` requests for EmDash media were served as full-size originals; they now redirect to the zone's `/cdn-cgi/image/` transformation of the media file, so Cloudflare resizes them at the edge. Image Transformations must be enabled on the zone, as it already must be for public images in this mode.
