---
"@emdash-cms/admin": patch
---

Fixes the admin downloading full-size originals for image previews. Editor body images, galleries, featured and image-field previews, avatars and media library thumbnails now request a rendition sized to the box they fill at the screen's pixel density, through the site's configured image service. Each editor image is requested once, after a single metadata request for all of an entry's media, instead of twice, and images below the fold in a long entry load as they scroll into view. Phone and high-density screens get sharp thumbnails instead of fixed 400 px and 80 px ones.
