---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Improves caching of media URLs that carry a `_emdash_media` content hash, such as the admin's previews and thumbnails. When the bytes served hash to that value, the media file route and image renditions are sent with `Cache-Control: public, max-age=31536000, immutable`, so browsers stop revalidating them. Replacing a file changes its hash and so its URL. URLs without a hash, or with one that doesn't match the stored file still revalidate on every use. So do originals over 2 MB, their Cloudflare Images renditions, and every `304 Not Modified` response. A rendition's `304 Not Modified` response no longer reports the source file's content type.
