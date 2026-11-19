---
"emdash": patch
---

Fixes locally stored media being served as full-size originals on public pages when the site URL is not known at build time. The `Image` component and images in rich text now get resized `srcset` candidates through EmDash's image endpoint without `siteUrl`, `EMDASH_SITE_URL`, or `SITE_URL` in the build environment. This includes sites deployed from the shipped templates, which set no site URL. It applies to Astro's sharp and passthrough image services and the Cloudflare adapter's services. Prerendered pages still need the site URL at build time, and a custom `image.service` keeps receiving the public URL of each image as before.
