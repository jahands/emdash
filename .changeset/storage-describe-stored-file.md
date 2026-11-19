---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Adds an optional `describeStoredFile(key)` method to the `Storage` interface. It returns a stored file's `contentType`, `size` and `lastModified` without reading the file, or `null` when there is no file at the key. The R2, S3 and local adapters implement it, and the media file route uses it to answer `HEAD` requests without downloading the file. Custom adapters don't need to change: without the method, or when it returns something else, the route downloads the file as before.
