---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Improves caching of media URLs that carry a `_emdash_media` content hash, such as the admin's previews and thumbnails. When the hash matches the stored file, the media file route and image renditions are sent with `Cache-Control: public, max-age=31536000, immutable`, so browsers stop revalidating them. Replacing a file changes its hash and so its URL. URLs without a hash, or with one that doesn't match, still revalidate on every use. A rendition's `304 Not Modified` response no longer reports the source file's content type.
