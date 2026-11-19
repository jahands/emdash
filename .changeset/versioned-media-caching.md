---
"emdash": patch
"@emdash-cms/cloudflare": patch
---

Improves caching of media URLs that carry a `_emdash_media` content hash, such as the admin's previews and thumbnails. When the bytes served hash to that value, the media file route and image renditions are sent with `Cache-Control: public, max-age=31536000, immutable`, so browsers stop revalidating them. Replacing a file changes its hash and so its URL. URLs without a hash, or with one that doesn't match the stored file still revalidate on every use. So do originals over 2 MB, their Cloudflare Images renditions, `HEAD` responses, and every `304 Not Modified` response. A rendition's `304 Not Modified` response no longer reports the source file's content type. `HEAD` requests to the media file route no longer read the file from storage. They use the new optional `Storage.stat(key)`, which the R2, S3 and local adapters implement; a custom adapter without it still answers `HEAD` by downloading the file.
